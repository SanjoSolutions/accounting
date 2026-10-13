import 'server-only'
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@/generated/prisma/client'
import { prisma } from '@/server/persistence/client'
import { evaluateHgbClose, type HgbCloseProfile } from '@/core/hgbClose'
import { hgbWorkpaperChecksum, validateHgbWorkpaper } from '@/core/hgbWorkpapers'
import { validateHgbReviewPolicyChoice, type HgbReviewPolicy, type HgbReviewPolicyChoice } from '@/core/hgbReviewPolicy'
import { ComplianceRuntimeError } from '@/server/compliance/runtime'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'

type Client = Prisma.TransactionClient | typeof prisma
type Period = { id: string; startsAt: Date; endsAt: Date; status: string }
const dateOnly = (date: Date) => date.toISOString().slice(0, 10)
const profileBlockers = new Set(['RULE_SET_UNSUPPORTED', 'APPLICABILITY_FACTS_UNKNOWN', 'ENTITY_SCOPE_UNSUPPORTED', 'PERIOD_SCOPE_UNSUPPORTED', 'SIZE_UNDETERMINED_OR_UNSUPPORTED', 'INVENTORY_APPLICABILITY_UNKNOWN', 'FIXED_ASSET_APPLICABILITY_UNKNOWN'])

async function eligibilitySources(client: Client, ownerId: string, period: Period) {
  const [company, size] = await Promise.all([
    client.companyProfileVersion.findFirst({ where: { ownerId, effectiveFrom: { lte: period.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.endsAt } }] }, orderBy: { effectiveFrom: 'desc' } }),
    client.hgbWorkpaperRecord.findFirst({ where: { ownerId, fiscalPeriodId: period.id, kind: 'SIZE_AND_APPLICABILITY' }, orderBy: { version: 'desc' } }),
  ])
  if (!company || !size || !['PREPARED', 'REVIEWED'].includes(size.status)) throw new ComplianceRuntimeError('Prepare the size and applicability workpaper before selecting owner self-review.', 409)
  const payload = validateHgbWorkpaper(JSON.parse(size.payload), { startsAt: dateOnly(period.startsAt), endsAt: dateOnly(period.endsAt) })
  if (hgbWorkpaperChecksum({ ownerId, fiscalPeriodId: period.id, kind: size.kind, payload }) !== size.checksum || payload.schedule.type !== 'SIZE_APPLICABILITY') throw new ComplianceRuntimeError('The size workpaper is invalid.', 409)
  const profile = JSON.parse(company.payload)
  const closeProfile: HgbCloseProfile = { ...payload.schedule.closeProfile, legalForm: profile.legalForm, germanRegisteredEntity: profile.registeredAddress?.country === 'DE', fiscalPeriodStart: dateOnly(period.startsAt), fiscalPeriodEnd: dateOnly(period.endsAt) }
  const readiness = evaluateHgbClose({ profile: closeProfile, workpapers: [] })
  if (closeProfile.legalForm !== 'UG' || readiness.blockers.some(blocker => profileBlockers.has(blocker.code))) throw new ComplianceRuntimeError('Owner self-review is limited to the supported MICRO/SMALL standalone UG scope.', 409)
  return { companyProfileId: company.id, companyProfileChecksum: hgbWorkpaperChecksum(JSON.parse(company.payload)), sizeWorkpaperId: size.id, sizeWorkpaperChecksum: size.checksum }
}

export async function requireHgbEvidence(client: Client, ownerId: string, ids: string[]) {
  const [documents, artifacts] = await Promise.all([
    client.documentRecord.findMany({ where: { ownerId, id: { in: ids } }, select: { id: true, payload: true } }),
    client.retainedArtifact.findMany({ where: { ownerId, id: { in: ids }, disposedAt: null, storageDeletedAt: null }, select: { id: true, contentHash: true } }),
  ])
  const evidence = [...documents.map(row => ({ id: row.id, hash: hgbWorkpaperChecksum(row.payload) })), ...artifacts.map(row => ({ id: row.id, hash: row.contentHash }))].sort((a, b) => a.id.localeCompare(b.id))
  if (ids.some(id => !evidence.some(row => row.id === id))) throw new ComplianceRuntimeError('Policy evidence is missing or outside the authenticated tenant.', 409)
  return evidence
}

export async function loadHgbReviewPolicy(client: Client, ownerId: string, period: Period): Promise<{ policy: HgbReviewPolicy | null; valid: boolean }> {
  const record = await client.hgbReviewPolicyRecord.findFirst({ where: { ownerId, fiscalPeriodId: period.id }, orderBy: { version: 'desc' } })
  if (!record) return { policy: null, valid: true }
  let policy: HgbReviewPolicy | null = null
  try {
    const payload = JSON.parse(record.payload)
    const choice = validateHgbReviewPolicyChoice(payload.choice)
    policy = { ...choice, id: record.id, version: record.version, checksum: record.checksum, ownerId, selectedBy: record.selectedBy, selectedAt: record.selectedAt.toISOString() }
    if (record.selectedBy !== ownerId || record.checksum !== hgbWorkpaperChecksum({ id: record.id, ownerId, fiscalPeriodId: period.id, version: record.version, selectedBy: record.selectedBy, selectedAt: policy.selectedAt, payload })) return { policy, valid: false }
    const evidence = await requireHgbEvidence(client, ownerId, choice.evidenceIds)
    if (hgbWorkpaperChecksum(evidence) !== hgbWorkpaperChecksum(payload.evidence)) return { policy, valid: false }
    if (choice.mode === 'OWNER_SELF_REVIEW' && hgbWorkpaperChecksum(await eligibilitySources(client, ownerId, period)) !== hgbWorkpaperChecksum(payload.sources)) return { policy, valid: false }
    return { policy, valid: true }
  } catch { return { policy, valid: false } }
}

export async function selectHgbReviewPolicy(ownerId: string, actorId: string, year: number, input: HgbReviewPolicyChoice, expectedPolicyId: string | null) {
  if (actorId !== ownerId) throw new ComplianceRuntimeError('Only the company owner can select the HGB review policy.', 403)
  const choice = validateHgbReviewPolicyChoice(input)
  return prisma.$transaction(async client => {
    const period = await client.fiscalYear.findUnique({ where: { ownerId_year: { ownerId, year } } })
    if (!period || period.status !== 'OPEN') throw new ComplianceRuntimeError('Select review policy only for an open fiscal period.', 409)
    const latest = await client.hgbReviewPolicyRecord.findFirst({ where: { ownerId, fiscalPeriodId: period.id }, orderBy: { version: 'desc' } })
    if ((latest?.id ?? null) !== expectedPolicyId) throw new ComplianceRuntimeError('Review policy changed; reload before selecting a policy.', 409)
    const sources = choice.mode === 'OWNER_SELF_REVIEW' ? await eligibilitySources(client, ownerId, period) : null
    const payload = { choice, sources, evidence: await requireHgbEvidence(client, ownerId, choice.evidenceIds) }
    const id = randomUUID(); const selectedAt = new Date(); const version = (latest?.version ?? 0) + 1
    const checksum = hgbWorkpaperChecksum({ id, ownerId, fiscalPeriodId: period.id, version, selectedBy: actorId, selectedAt: selectedAt.toISOString(), payload })
    await client.hgbReviewPolicyRecord.create({ data: { id, ownerId, fiscalPeriodId: period.id, version, selectedBy: actorId, selectedAt, payload: JSON.stringify(payload), checksum } })
    await appendAuditEvent(client, { ownerId, actorId, action: 'HGB_REVIEW_POLICY_SELECTED', reason: choice.reason, objectType: 'HgbReviewPolicyRecord', objectId: id, before: { policyId: latest?.id ?? null }, after: { version, checksum, ...choice } })
    return { ...choice, id, ownerId, version, selectedBy: actorId, selectedAt: selectedAt.toISOString(), checksum }
  })
}
