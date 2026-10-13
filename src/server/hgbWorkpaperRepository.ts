import 'server-only'

import { randomUUID } from 'node:crypto'
import { HGB_WORKPAPER_RULE_SET, assertHgbReview, hgbWorkpaperChecksum, validateHgbWorkpaper, type HgbWorkpaperDraft } from '@/core/hgbWorkpapers'
import { prisma } from '@/server/persistence/client'
import { ComplianceRuntimeError } from '@/server/compliance/runtime'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'
import { postJournalEntry } from '@/server/ledger'
import { loadHgbReviewPolicy, requireHgbEvidence } from '@/server/hgbReviewPolicyRepository'
import { reviewMatchesPolicy } from '@/core/hgbReviewPolicy'

const dateOnly = (date: Date) => date.toISOString().slice(0, 10)
const parsePayload = <T>(payload: string): T => JSON.parse(payload) as T

async function period(ownerId: string, year: number) {
  const fiscalPeriod = await prisma.fiscalYear.findUnique({ where: { ownerId_year: { ownerId, year } } })
  if (!fiscalPeriod) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  return fiscalPeriod
}

function evidenceIds(workpaper: ReturnType<typeof validateHgbWorkpaper>) {
  const ids = [...workpaper.evidenceIds, ...workpaper.adjustments.flatMap(proposal => proposal.evidenceIds)]
  const collect = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) { if (/evidenceIds$/i.test(key)) { for (const id of value) if (typeof id === 'string') ids.push(id) } else { for (const item of value) collect(item, key) } return }
    if (!value || typeof value !== 'object') { if (/evidenceId$/i.test(key) && typeof value === 'string') ids.push(value); return }
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) collect(child, childKey)
  }
  collect(workpaper.schedule)
  return [...new Set(ids.map(id => id.trim()).filter(Boolean))].sort()
}

async function requireEvidence(ownerId: string, ids: string[]) {
  const [documents, artifacts] = await Promise.all([
    prisma.documentRecord.findMany({ where: { ownerId, id: { in: ids } }, select: { id: true } }),
    prisma.retainedArtifact.findMany({ where: { ownerId, id: { in: ids }, disposedAt: null, storageDeletedAt: null }, select: { id: true } }),
  ])
  const found = new Set([...documents, ...artifacts].map(item => item.id))
  const missing = ids.filter(id => !found.has(id))
  if (missing.length) throw new ComplianceRuntimeError(`Workpaper evidence is missing or outside the authenticated tenant: ${missing.join(', ')}`, 409)
}

export async function listHgbWorkpapers(ownerId: string, year: number) {
  const fiscalPeriod = await period(ownerId, year)
  const reviewPolicy = await loadHgbReviewPolicy(prisma, ownerId, fiscalPeriod)
  const records = await prisma.hgbWorkpaperRecord.findMany({ where: { ownerId, fiscalPeriodId: fiscalPeriod.id }, orderBy: [{ kind: 'asc' }, { version: 'desc' }] })
  const latest = records.filter((record, index) => records.findIndex(candidate => candidate.kind === record.kind) === index)
  const adjustments = latest.length ? await prisma.hgbAdjustmentRecord.findMany({ where: { ownerId, workpaperId: { in: latest.map(record => record.id) } }, orderBy: [{ workpaperId: 'asc' }, { proposalId: 'asc' }] }) : []
  return {
    reviewPolicy: reviewPolicy.policy, reviewPolicyValid: reviewPolicy.valid,
    fiscalPeriod: { id: fiscalPeriod.id, year: fiscalPeriod.year, startsAt: dateOnly(fiscalPeriod.startsAt), endsAt: dateOnly(fiscalPeriod.endsAt), status: fiscalPeriod.status },
    workpapers: latest.map(record => ({ ...record, payload: parsePayload<HgbWorkpaperDraft>(record.payload), adjustments: adjustments.filter(item => item.workpaperId === record.id).map(item => ({ ...item, payload: parsePayload(item.payload) })) })),
  }
}

export async function saveHgbWorkpaper(ownerId: string, actorId: string, year: number, input: HgbWorkpaperDraft, expectedChecksum?: string) {
  const fiscalPeriod = await period(ownerId, year)
  if (fiscalPeriod.status !== 'OPEN') throw new ComplianceRuntimeError('HGB workpapers can only be edited while the fiscal period is open', 409)
  let validated: ReturnType<typeof validateHgbWorkpaper>
  try { validated = validateHgbWorkpaper(input, { startsAt: dateOnly(fiscalPeriod.startsAt), endsAt: dateOnly(fiscalPeriod.endsAt) }) }
  catch (error) { throw new ComplianceRuntimeError(error instanceof Error ? error.message : 'HGB workpaper is invalid') }
  const payload = JSON.stringify(validated)
  const checksum = hgbWorkpaperChecksum({ ownerId, fiscalPeriodId: fiscalPeriod.id, kind: validated.kind, payload: validated })
  const latest = await prisma.hgbWorkpaperRecord.findFirst({ where: { ownerId, fiscalPeriodId: fiscalPeriod.id, kind: validated.kind }, orderBy: { version: 'desc' } })
  if (latest?.status === 'DRAFT') {
    if (!expectedChecksum || expectedChecksum !== latest.checksum) throw new ComplianceRuntimeError('The draft changed; reload it before saving', 409)
    const updated = await prisma.hgbWorkpaperRecord.update({ where: { id: latest.id }, data: { payload, checksum, updatedBy: actorId } })
    await appendAuditEvent(prisma, { ownerId, actorId, action: 'HGB_WORKPAPER_DRAFT_UPDATED', reason: 'Typed workpaper edit', objectType: 'HgbWorkpaperRecord', objectId: updated.id, before: { checksum: latest.checksum }, after: { checksum } })
    return { ...updated, payload: validated }
  }
  const created = await prisma.hgbWorkpaperRecord.create({ data: { id: randomUUID(), ownerId, fiscalPeriodId: fiscalPeriod.id, kind: validated.kind, version: (latest?.version ?? 0) + 1, status: 'DRAFT', ruleSetVersion: HGB_WORKPAPER_RULE_SET, payload, checksum, supersedesId: latest?.id, createdBy: actorId, updatedBy: actorId } })
  await appendAuditEvent(prisma, { ownerId, actorId, action: 'HGB_WORKPAPER_DRAFT_CREATED', reason: 'Typed workpaper edit', objectType: 'HgbWorkpaperRecord', objectId: created.id, after: { kind: created.kind, version: created.version, checksum } })
  return { ...created, payload: validated }
}

export async function prepareHgbWorkpaper(ownerId: string, actorId: string, workpaperId: string, expectedChecksum: string) {
  const record = await prisma.hgbWorkpaperRecord.findFirst({ where: { id: workpaperId, ownerId } })
  if (!record) throw new ComplianceRuntimeError('HGB workpaper not found', 404)
  if (record.status !== 'DRAFT' && record.status !== 'REJECTED') throw new ComplianceRuntimeError('Only a draft or rejected workpaper can be prepared', 409)
  if (record.checksum !== expectedChecksum || hgbWorkpaperChecksum({ ownerId, fiscalPeriodId: record.fiscalPeriodId, kind: record.kind, payload: parsePayload(record.payload) }) !== record.checksum) throw new ComplianceRuntimeError('Workpaper checksum is stale or invalid', 409)
  const fiscalPeriod = await prisma.fiscalYear.findFirst({ where: { id: record.fiscalPeriodId, ownerId } })
  if (!fiscalPeriod || fiscalPeriod.status !== 'OPEN') throw new ComplianceRuntimeError('The authoritative fiscal period is not open', 409)
  const validated = validateHgbWorkpaper(parsePayload(record.payload), { startsAt: dateOnly(fiscalPeriod.startsAt), endsAt: dateOnly(fiscalPeriod.endsAt) })
  await requireEvidence(ownerId, evidenceIds(validated))
  const prepared = await prisma.hgbWorkpaperRecord.update({ where: { id: record.id }, data: { status: 'PREPARED', preparedBy: actorId, preparedAt: new Date(), reviewedBy: null, reviewedAt: null, reviewReason: null, reviewMode: 'INDEPENDENT', reviewPolicyId: null, reviewEvidenceChecksum: null, updatedBy: actorId } })
  await appendAuditEvent(prisma, { ownerId, actorId, action: 'HGB_WORKPAPER_PREPARED', reason: 'Preparation completed', objectType: 'HgbWorkpaperRecord', objectId: record.id, after: { checksum: record.checksum, preparedBy: actorId } })
  return { ...prepared, payload: validated }
}

export async function reviewHgbWorkpaper(ownerId: string, reviewerId: string, workpaperId: string, decision: 'APPROVE' | 'REJECT', reason?: string, year?: number, expectedChecksum?: string, expectedPolicyId?: string | null) {
  return prisma.$transaction(async transaction => {
    const record = await transaction.hgbWorkpaperRecord.findFirst({ where: { id: workpaperId, ownerId } })
    if (!record) throw new ComplianceRuntimeError('HGB workpaper not found', 404)
    if (record.status !== 'PREPARED' || !record.preparedBy) throw new ComplianceRuntimeError('Only a prepared workpaper can be reviewed', 409)
    const fiscalPeriod = await transaction.fiscalYear.findFirst({ where: { id: record.fiscalPeriodId, ownerId, ...(year === undefined ? {} : { year }) } })
    if (!fiscalPeriod || fiscalPeriod.status !== 'OPEN') throw new ComplianceRuntimeError('The authoritative fiscal period is not open or does not match the requested year', 409)
    const { policy, valid } = await loadHgbReviewPolicy(transaction, ownerId, fiscalPeriod)
    if (!valid || expectedPolicyId !== undefined && expectedPolicyId !== (policy?.id ?? null)) throw new ComplianceRuntimeError('Review policy is stale; reload and select the current policy.', 409)
    let reviewMode: 'INDEPENDENT' | 'OWNER_SELF_REVIEW'
    try { reviewMode = assertHgbReview(record.preparedBy, reviewerId, decision, reason, policy) } catch (error) { throw new ComplianceRuntimeError((error as Error).message) }
    const payload = validateHgbWorkpaper(parsePayload(record.payload), { startsAt: dateOnly(fiscalPeriod.startsAt), endsAt: dateOnly(fiscalPeriod.endsAt) })
    if (expectedChecksum !== undefined && expectedChecksum !== record.checksum || hgbWorkpaperChecksum({ ownerId, fiscalPeriodId: record.fiscalPeriodId, kind: record.kind, payload }) !== record.checksum) throw new ComplianceRuntimeError('Workpaper checksum is stale or invalid', 409)
    // Resolve evidence in the same transaction as the review and adjustment registration.
    const ids = evidenceIds(payload)
    const [documents, artifacts] = await Promise.all([
      transaction.documentRecord.findMany({ where: { ownerId, id: { in: ids } }, select: { id: true } }),
      transaction.retainedArtifact.findMany({ where: { ownerId, id: { in: ids }, disposedAt: null, storageDeletedAt: null }, select: { id: true } }),
    ])
    if (ids.some(id => ![...documents, ...artifacts].some(item => item.id === id))) throw new ComplianceRuntimeError('Workpaper evidence is missing or outside the authenticated tenant.', 409)
    const reviewEvidenceChecksum = hgbWorkpaperChecksum(await requireHgbEvidence(transaction, ownerId, ids))
    const status = decision === 'APPROVE' ? 'REVIEWED' : 'REJECTED'
    const reviewedAt = new Date()
    const reviewed = await transaction.hgbWorkpaperRecord.update({ where: { id: record.id, status: 'PREPARED', checksum: record.checksum }, data: { status, reviewedBy: reviewerId, reviewedAt, reviewReason: reason?.trim() || null, reviewMode, reviewPolicyId: policy?.id ?? null, reviewEvidenceChecksum, updatedBy: reviewerId } })
    if (decision === 'APPROVE') for (const proposal of payload.adjustments) {
      // A new policy requires new review records, but an identical posted proposal
      // still refers to the original journal entry and must never be posted twice.
      const prior = await transaction.hgbAdjustmentRecord.findFirst({ where: { ownerId, fiscalPeriodId: record.fiscalPeriodId, fingerprint: proposal.fingerprint, status: 'POSTED' }, orderBy: { createdAt: 'desc' } })
      await transaction.hgbAdjustmentRecord.create({ data: { id: randomUUID(), ownerId, fiscalPeriodId: record.fiscalPeriodId, workpaperId: record.id, proposalId: proposal.id, fingerprint: proposal.fingerprint, payload: JSON.stringify(proposal), ...(prior ? { status: 'POSTED', postedEntryId: prior.postedEntryId, postedBy: prior.postedBy, postedAt: prior.postedAt } : {}) } })
    }
    await appendAuditEvent(transaction, { ownerId, actorId: reviewerId, action: `HGB_WORKPAPER_${status}`, reason: reason?.trim() || 'Independent review completed', objectType: 'HgbWorkpaperRecord', objectId: record.id, after: { status, checksum: record.checksum, preparedBy: record.preparedBy, reviewedBy: reviewerId, reviewedAt: reviewedAt.toISOString(), reviewMode, reviewEvidenceChecksum, reviewPolicyId: policy?.id ?? null, reviewPolicyChecksum: policy?.checksum ?? null } })
    return { ...reviewed, payload }
  })
}

export async function postHgbAdjustment(ownerId: string, actorId: string, year: number, workpaperId: string, proposalId: string, idempotencyKey: string) {
  if (!idempotencyKey.trim()) throw new ComplianceRuntimeError('An idempotency key is required')
  const fiscalPeriod = await period(ownerId, year)
  if (fiscalPeriod.status !== 'OPEN') throw new ComplianceRuntimeError('The fiscal period must be open for adjustment posting', 409)
  const workpaper = await prisma.hgbWorkpaperRecord.findFirst({ where: { id: workpaperId, ownerId, fiscalPeriodId: fiscalPeriod.id, status: 'REVIEWED' } })
  if (!workpaper) throw new ComplianceRuntimeError('A reviewed workpaper in the authoritative period is required', 409)
  const { policy, valid } = await loadHgbReviewPolicy(prisma, ownerId, fiscalPeriod)
  if (!valid || !reviewMatchesPolicy(workpaper, policy)) throw new ComplianceRuntimeError('The adjustment review policy is stale or invalid.', 409)
  const latest = await prisma.hgbWorkpaperRecord.findFirst({ where: { ownerId, fiscalPeriodId: fiscalPeriod.id, kind: workpaper.kind }, orderBy: { version: 'desc' } })
  const reviewedPayload = validateHgbWorkpaper(parsePayload(workpaper.payload), { startsAt: dateOnly(fiscalPeriod.startsAt), endsAt: dateOnly(fiscalPeriod.endsAt) })
  const currentEvidenceChecksum = hgbWorkpaperChecksum(await requireHgbEvidence(prisma, ownerId, evidenceIds(reviewedPayload)))
  if (latest?.id !== workpaper.id || hgbWorkpaperChecksum({ ownerId, fiscalPeriodId: fiscalPeriod.id, kind: workpaper.kind, payload: reviewedPayload }) !== workpaper.checksum || workpaper.reviewEvidenceChecksum && workpaper.reviewEvidenceChecksum !== currentEvidenceChecksum || workpaper.reviewMode === 'OWNER_SELF_REVIEW' && !workpaper.reviewEvidenceChecksum) throw new ComplianceRuntimeError('The reviewed workpaper or evidence changed; review the latest version before posting.', 409)
  const adjustment = await prisma.hgbAdjustmentRecord.findFirst({ where: { ownerId, workpaperId, proposalId } })
  if (!adjustment) throw new ComplianceRuntimeError('Reviewed adjustment proposal not found', 404)
  const priorKey = await prisma.hgbAdjustmentRecord.findUnique({ where: { ownerId_idempotencyKey: { ownerId, idempotencyKey } } })
  if (priorKey && priorKey.id !== adjustment.id) throw new ComplianceRuntimeError('Idempotency key is already bound to another adjustment', 409)
  if (adjustment.status === 'POSTED') return adjustment
  const externalKey = `hgb-adjustment:${ownerId}:${fiscalPeriod.id}:${adjustment.fingerprint}`
  let recovered = await prisma.journalEntry.findUnique({ where: { externalKey } }) ?? await prisma.journalEntry.findUnique({ where: { externalKey: `hgb-adjustment:${adjustment.id}:${adjustment.fingerprint}` } })
  if (!recovered) {
    // Older versions used the adjustment-row ID in their external key. Recover a
    // committed journal even if that revision's final POSTED update was interrupted.
    const earlier = await prisma.hgbAdjustmentRecord.findMany({ where: { ownerId, fiscalPeriodId: fiscalPeriod.id, fingerprint: adjustment.fingerprint, id: { not: adjustment.id } }, select: { id: true } })
    for (const previous of earlier) {
      recovered = await prisma.journalEntry.findUnique({ where: { externalKey: `hgb-adjustment:${previous.id}:${adjustment.fingerprint}` } })
      if (recovered) break
    }
  }
  if (recovered) return prisma.hgbAdjustmentRecord.update({ where: { id: adjustment.id }, data: { status: 'POSTED', idempotencyKey, postedEntryId: recovered.id, postedBy: actorId, postedAt: new Date() } })
  if (adjustment.idempotencyKey && adjustment.idempotencyKey !== idempotencyKey) throw new ComplianceRuntimeError('Adjustment posting is already reserved by another request', 409)
  await prisma.hgbAdjustmentRecord.update({ where: { id: adjustment.id }, data: { status: 'POSTING', idempotencyKey } })
  const proposal = parsePayload<ReturnType<typeof validateHgbWorkpaper>['adjustments'][number]>(adjustment.payload)
  if (proposal.fingerprint !== adjustment.fingerprint || hgbWorkpaperChecksum({ id: proposal.id, bookingDate: proposal.bookingDate, description: proposal.description, evidenceIds: proposal.evidenceIds, lines: proposal.lines }) !== proposal.fingerprint) throw new ComplianceRuntimeError('Adjustment proposal fingerprint is invalid', 409)
  await requireEvidence(ownerId, [...proposal.evidenceIds])
  const entry = await postJournalEntry(ownerId, { fiscalYear: year, bookingDate: proposal.bookingDate, documentNumber: `SYS-HGB-${adjustment.id}`, description: proposal.description, lines: proposal.lines.map(line => ({ accountId: line.accountId, debitCents: line.debitCents, creditCents: line.creditCents })) }, 'HGB_CLOSE', { externalKey, entryDate: new Date().toISOString().slice(0, 10), lateReason: `Reviewed HGB workpaper ${workpaper.id}` })
  const posted = await prisma.hgbAdjustmentRecord.update({ where: { id: adjustment.id }, data: { status: 'POSTED', postedEntryId: entry.id, postedBy: actorId, postedAt: new Date() } })
  await appendAuditEvent(prisma, { ownerId, actorId, action: 'HGB_ADJUSTMENT_POSTED', reason: `Reviewed HGB workpaper ${workpaper.id}`, objectType: 'HgbAdjustmentRecord', objectId: adjustment.id, after: { fingerprint: adjustment.fingerprint, postedEntryId: entry.id } })
  return posted
}
