import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import type { Prisma } from '@/generated/prisma/client'
import {
  evaluateHgbClose, HGB_RULE_SET_2024,
  type HgbCloseProfile, type HgbCloseReadiness, type HgbCloseReadinessInput,
} from '@/core/hgbClose'
import { prisma } from '@/server/persistence/client'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'
import { ComplianceRuntimeError } from '@/server/compliance/runtime'
import { AccountingValidationError } from '@/core/doubleEntry'
import { hgbWorkpaperChecksum, validateHgbWorkpaper, type HgbWorkpaperDraft } from '@/core/hgbWorkpapers'

type JsonRecord = Record<string, unknown>

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ComplianceRuntimeError('HGB close input must contain finite numbers')
    return String(value)
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as JsonRecord).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  throw new ComplianceRuntimeError('HGB close input must be JSON-compatible')
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
const dateOnly = (value: Date) => value.toISOString().slice(0, 10)
const record = (value: unknown, label: string): JsonRecord => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComplianceRuntimeError(`${label} must be an object`)
  return structuredClone(value) as JsonRecord
}

function persistedWorkpaperEvidenceIds(payload: JsonRecord): string[] {
  const ids: string[] = []
  const collect = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) {
      if (/evidenceIds$/i.test(key)) { for (const id of value) if (typeof id === 'string' && id.trim()) ids.push(id.trim()) }
      else { for (const item of value) collect(item, key) }
      return
    }
    if (!value || typeof value !== 'object') { if (/evidenceId$/i.test(key) && typeof value === 'string' && value.trim()) ids.push(value.trim()); return }
    for (const [childKey, child] of Object.entries(value as JsonRecord)) collect(child, childKey)
  }
  collect(payload)
  return [...new Set(ids)].sort()
}

export function hgbCloseFingerprint(input: {
  fiscalPeriod: { id: string; startsAt: Date; endsAt: Date }
  profileVersion: { id: string; effectiveFrom: Date; effectiveTo: Date | null; payload: string }
  mappings: Array<{ id: string; accountNumber: number; effectiveFrom: Date; effectiveTo: Date | null; accountName: string; accountType: string; normalBalance: string; hgbPosition: string; active: boolean }>
  entries: Array<{ id: string; sequenceNumber: number; bookingDate: Date; state: string; lines: Array<{ id: string; accountId: string; debitCents: number; creditCents: number }> }>
  evidence?: Array<{ id: string; source: string; contentHash: string }>
  workpapers?: Array<{ id: string; kind: string; version: number; status: string; checksum: string; payload: string; preparedBy: string | null; reviewedBy: string | null; reviewedAt: Date | null }>
  adjustments?: Array<{ id: string; workpaperId: string; proposalId: string; fingerprint: string; status: string; postedEntryId: string | null; payload: string }>
}) {
  const payload = {
    fiscalPeriod: { id: input.fiscalPeriod.id, startsAt: dateOnly(input.fiscalPeriod.startsAt), endsAt: dateOnly(input.fiscalPeriod.endsAt) },
    profileVersion: { id: input.profileVersion.id, effectiveFrom: input.profileVersion.effectiveFrom.toISOString(), effectiveTo: input.profileVersion.effectiveTo?.toISOString() ?? null, payload: JSON.parse(input.profileVersion.payload) },
    mappings: [...input.mappings].sort((a, b) => a.accountNumber - b.accountNumber || a.effectiveFrom.getTime() - b.effectiveFrom.getTime() || a.id.localeCompare(b.id)).map(mapping => ({ ...mapping, effectiveFrom: mapping.effectiveFrom.toISOString(), effectiveTo: mapping.effectiveTo?.toISOString() ?? null })),
    entries: [...input.entries].sort((a, b) => a.sequenceNumber - b.sequenceNumber || a.id.localeCompare(b.id)).map(entry => ({ ...entry, bookingDate: entry.bookingDate.toISOString(), lines: [...entry.lines].sort((a, b) => a.id.localeCompare(b.id)) })),
    evidence: [...(input.evidence ?? [])].sort((a, b) => a.id.localeCompare(b.id) || a.source.localeCompare(b.source)),
    workpapers: [...(input.workpapers ?? [])].sort((a, b) => a.kind.localeCompare(b.kind) || b.version - a.version).map(item => ({ ...item, payload: JSON.parse(item.payload), reviewedAt: item.reviewedAt?.toISOString() ?? null })),
    adjustments: [...(input.adjustments ?? [])].sort((a, b) => a.workpaperId.localeCompare(b.workpaperId) || a.proposalId.localeCompare(b.proposalId)).map(item => ({ ...item, payload: JSON.parse(item.payload) })),
  }
  return sha256(canonicalJson(payload))
}

type HgbPersistenceClient = Prisma.TransactionClient | typeof prisma

async function loadAuthoritativeContext(client: HgbPersistenceClient, ownerId: string, year: number, suppliedEvidenceIds: string[] = []) {
  const fiscalPeriod = await client.fiscalYear.findUnique({
    where: { ownerId_year: { ownerId, year } },
    include: { journalEntries: { where: { state: 'POSTED' }, include: { lines: true }, orderBy: [{ sequenceNumber: 'asc' }, { id: 'asc' }] } },
  })
  if (!fiscalPeriod) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  const profileVersion = await client.companyProfileVersion.findFirst({
    where: { ownerId, effectiveFrom: { lte: fiscalPeriod.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: fiscalPeriod.endsAt } }] },
    orderBy: { effectiveFrom: 'desc' },
  })
  if (!profileVersion) throw new ComplianceRuntimeError('An authoritative company profile covering the fiscal-period end is required', 409)
  const companyProfile = record(JSON.parse(profileVersion.payload), 'Authoritative company profile')
  const chart = typeof companyProfile.chart === 'string' && companyProfile.chart.trim() ? companyProfile.chart : undefined
  if (!chart) throw new ComplianceRuntimeError('The authoritative company profile must select a chart', 409)
  const mappings = await client.accountMappingVersion.findMany({
    where: { ownerId, chartId: chart, effectiveFrom: { lte: fiscalPeriod.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: fiscalPeriod.startsAt } }] },
    orderBy: [{ accountNumber: 'asc' }, { effectiveFrom: 'asc' }, { id: 'asc' }],
  })
  if (!mappings.length) throw new ComplianceRuntimeError('Authoritative account mappings covering the fiscal period are required', 409)
  const allWorkpapers = await client.hgbWorkpaperRecord.findMany({ where: { ownerId, fiscalPeriodId: fiscalPeriod.id }, orderBy: [{ kind: 'asc' }, { version: 'desc' }] })
  const workpapers = allWorkpapers.filter((item, index) => allWorkpapers.findIndex(candidate => candidate.kind === item.kind) === index)
  const invalidWorkpaperIds = workpapers.filter(item => {
    try {
      const payload = validateHgbWorkpaper(JSON.parse(item.payload) as HgbWorkpaperDraft, { startsAt: dateOnly(fiscalPeriod.startsAt), endsAt: dateOnly(fiscalPeriod.endsAt) })
      return hgbWorkpaperChecksum({ ownerId, fiscalPeriodId: fiscalPeriod.id, kind: item.kind, payload }) !== item.checksum
    } catch { return true }
  }).map(item => item.id)
  const adjustments = workpapers.length ? await client.hgbAdjustmentRecord.findMany({ where: { ownerId, workpaperId: { in: workpapers.map(item => item.id) } }, orderBy: [{ workpaperId: 'asc' }, { proposalId: 'asc' }] }) : []
  const workpaperEvidenceIds = workpapers.flatMap(item => {
    try {
      const payload = JSON.parse(item.payload) as JsonRecord
      return persistedWorkpaperEvidenceIds(payload)
    } catch { return [] }
  })
  const uniqueEvidenceIds = [...new Set([...suppliedEvidenceIds, ...workpaperEvidenceIds])].sort()
  const [artifacts, documents] = await Promise.all([
    uniqueEvidenceIds.length ? client.retainedArtifact.findMany({ where: { ownerId, id: { in: uniqueEvidenceIds }, disposedAt: null, storageDeletedAt: null }, select: { id: true, contentHash: true } }) : [],
    uniqueEvidenceIds.length ? client.documentRecord.findMany({ where: { ownerId, id: { in: uniqueEvidenceIds } }, select: { id: true, payload: true } }) : [],
  ])
  const evidence = [...artifacts.map(item => ({ id: item.id, source: 'RETAINED_ARTIFACT', contentHash: item.contentHash })), ...documents.map(item => ({ id: item.id, source: 'DOCUMENT', contentHash: sha256(item.payload) }))]
  const resolvedEvidenceIds = new Set(evidence.map(item => item.id))
  const missingEvidenceIds = uniqueEvidenceIds.filter(id => !resolvedEvidenceIds.has(id))
  const ledgerFingerprint = hgbCloseFingerprint({ fiscalPeriod, profileVersion, mappings, entries: fiscalPeriod.journalEntries, evidence: [...evidence, ...missingEvidenceIds.map(id => ({ id, source: 'MISSING', contentHash: '' }))], workpapers, adjustments })
  return { fiscalPeriod, profileVersion, companyProfile, mappings, workpapers, adjustments, invalidWorkpaperIds, ledgerFingerprint, missingEvidenceIds }
}

function referencedEvidenceIds(supplied: JsonRecord): string[] {
  const ids: string[] = []
  if (Array.isArray(supplied.managingDirectorSignatures)) for (const item of supplied.managingDirectorSignatures) if (item && typeof item === 'object' && !Array.isArray(item) && typeof (item as JsonRecord).signatureEvidenceId === 'string' && ((item as JsonRecord).signatureEvidenceId as string).trim()) ids.push(((item as JsonRecord).signatureEvidenceId as string).trim())
  if (typeof supplied.shareholderResolutionId === 'string' && supplied.shareholderResolutionId.trim()) ids.push(supplied.shareholderResolutionId.trim())
  return [...new Set(ids)].sort()
}

function authoritativeReadinessInput(context: Awaited<ReturnType<typeof loadAuthoritativeContext>>, supplied: JsonRecord): HgbCloseReadinessInput {
  const sizeWorkpaper = context.workpapers.find(item => item.kind === 'SIZE_AND_APPLICABILITY' && item.status === 'REVIEWED' && !context.invalidWorkpaperIds.includes(item.id))
  let suppliedProfile: JsonRecord = {}
  if (sizeWorkpaper) {
    const payload = record(JSON.parse(sizeWorkpaper.payload), 'Reviewed size workpaper')
    const schedule = record(payload.schedule, 'Reviewed size schedule')
    suppliedProfile = record(schedule.closeProfile, 'Reviewed HGB close profile')
  }
  const address = context.companyProfile.registeredAddress
  const country = address && typeof address === 'object' && !Array.isArray(address) ? (address as JsonRecord).country : undefined
  const profile: HgbCloseProfile = {
    ...(suppliedProfile as unknown as HgbCloseProfile),
    ruleSetVersion: HGB_RULE_SET_2024,
    legalForm: String(context.companyProfile.legalForm ?? ''),
    fiscalPeriodStart: dateOnly(context.fiscalPeriod.startsAt),
    fiscalPeriodEnd: dateOnly(context.fiscalPeriod.endsAt),
    germanRegisteredEntity: country === 'DE',
  }
  const workpapers = context.workpapers.filter(item => item.status === 'REVIEWED' && !context.invalidWorkpaperIds.includes(item.id)).map(item => {
    let payload: JsonRecord
    try { payload = record(JSON.parse(item.payload), `${item.kind} workpaper payload`) } catch { payload = {} }
    return {
      kind: item.kind,
      conclusion: payload.conclusion,
      evidenceIds: payload.evidenceIds,
      preparedBy: item.preparedBy,
      reviewedBy: item.reviewedBy,
      reviewedAt: item.reviewedAt?.toISOString(),
      reason: item.reviewReason ?? undefined,
    }
  })
  return {
    profile,
    workpapers: workpapers as HgbCloseReadinessInput['workpapers'],
    annualAccountsPackageId: typeof supplied.annualAccountsPackageId === 'string' ? supplied.annualAccountsPackageId : undefined,
    annualAccountsChecksum: typeof supplied.annualAccountsChecksum === 'string' ? supplied.annualAccountsChecksum : undefined,
    ledgerFingerprint: context.ledgerFingerprint,
    legalRepresentativeIds: Array.isArray(supplied.legalRepresentativeIds) ? structuredClone(supplied.legalRepresentativeIds) as string[] : undefined,
    managingDirectorSignatures: Array.isArray(supplied.managingDirectorSignatures) ? structuredClone(supplied.managingDirectorSignatures) as HgbCloseReadinessInput['managingDirectorSignatures'] : undefined,
    shareholderResolutionId: typeof supplied.shareholderResolutionId === 'string' ? supplied.shareholderResolutionId : undefined,
  }
}

async function requireAuthoritativeAnnualPackage(ownerId: string, fiscalPeriodId: string, input: HgbCloseReadinessInput): Promise<HgbCloseReadiness> {
  const readiness = evaluateHgbClose(input)
  if (!input.annualAccountsPackageId || !input.annualAccountsChecksum) return readiness
  const annualPackage = await prisma.compliancePackage.findFirst({ where: { id: input.annualAccountsPackageId, ownerId, fiscalPeriodId, kind: 'ANNUAL_ACCOUNTS', status: 'APPROVED', checksum: input.annualAccountsChecksum } })
  if (annualPackage) return readiness
  const blockers = readiness.blockers.filter(blocker => blocker.code !== 'ANNUAL_ACCOUNTS_PACKAGE_MISSING')
  blockers.push({ code: 'ANNUAL_ACCOUNTS_PACKAGE_NOT_AUTHORITATIVE', message: 'The annual-accounts package does not belong to this tenant and fiscal period or its checksum does not match.', authority: 'HGB §§ 242-245, 264-275' })
  return { ...readiness, status: 'BLOCKED', blockers }
}

export async function getHgbCloseRuns(ownerId: string, year: number) {
  const context = await loadAuthoritativeContext(prisma, ownerId, year)
  const runs = await prisma.hgbCloseRun.findMany({ where: { ownerId, fiscalPeriodId: context.fiscalPeriod.id }, orderBy: { version: 'desc' } })
  return { fiscalPeriod: { id: context.fiscalPeriod.id, year: context.fiscalPeriod.year, startsAt: dateOnly(context.fiscalPeriod.startsAt), endsAt: dateOnly(context.fiscalPeriod.endsAt) }, ledgerFingerprint: context.ledgerFingerprint, runs: runs.map(run => ({ ...run, payload: JSON.parse(run.payload) })) }
}

export async function evaluateAndPersistHgbClose(ownerId: string, actorId: string, year: number, supplied: JsonRecord) {
  const reason = typeof supplied.reason === 'string' ? supplied.reason.trim() : ''
  if (!reason) throw new ComplianceRuntimeError('reason is required')
  const context = await loadAuthoritativeContext(prisma, ownerId, year, referencedEvidenceIds(supplied))
  const input = authoritativeReadinessInput(context, supplied)
  let readiness = await requireAuthoritativeAnnualPackage(ownerId, context.fiscalPeriod.id, input)
  if (context.missingEvidenceIds.length) readiness = { ...readiness, status: 'BLOCKED', blockers: [...readiness.blockers, { code: 'EVIDENCE_NOT_AUTHORITATIVE', message: `Evidence references are missing or outside the authenticated tenant: ${context.missingEvidenceIds.join(', ')}`, authority: 'HGB §§ 238, 239, 257' }] }
  if (context.invalidWorkpaperIds.length) readiness = { ...readiness, status: 'BLOCKED', blockers: [...readiness.blockers, { code: 'WORKPAPER_INTEGRITY_INVALID', message: 'One or more current workpapers failed typed validation or checksum verification.', authority: 'HGB §§ 238, 239, 257' }] }
  const unposted = context.adjustments.filter(item => item.status !== 'POSTED')
  if (unposted.length) readiness = { ...readiness, status: 'BLOCKED', blockers: [...readiness.blockers, { code: 'ADJUSTMENTS_NOT_POSTED', message: 'Every adjustment proposed by the current reviewed workpapers must be posted before close.', authority: 'HGB §§ 239, 242, 252' }] }
  const inputChecksum = sha256(canonicalJson(input))
  const immutable = { input, readiness, authority: { fiscalPeriodId: context.fiscalPeriod.id, profileVersionId: context.profileVersion.id, mappingVersionIds: context.mappings.map(mapping => mapping.id) } }
  const payload = canonicalJson(immutable)
  const checksum = sha256(payload)
  const existing = await prisma.hgbCloseRun.findUnique({ where: { ownerId_checksum: { ownerId, checksum } } })
  if (existing) return { ...existing, payload: JSON.parse(existing.payload) }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await prisma.$transaction(async transaction => {
        const latest = await transaction.hgbCloseRun.findFirst({ where: { ownerId, fiscalPeriodId: context.fiscalPeriod.id }, orderBy: { version: 'desc' }, select: { version: true } })
        const run = await transaction.hgbCloseRun.create({ data: { id: randomUUID(), ownerId, fiscalPeriodId: context.fiscalPeriod.id, version: (latest?.version ?? 0) + 1, status: readiness.status, ruleSetVersion: readiness.ruleSetVersion, ledgerFingerprint: context.ledgerFingerprint, inputChecksum, checksum, payload, createdBy: actorId } })
        await appendAuditEvent(transaction, { ownerId, actorId, action: 'HGB_CLOSE_EVALUATED', reason, objectType: 'HgbCloseRun', objectId: run.id, after: { fiscalPeriodId: run.fiscalPeriodId, version: run.version, status: run.status, checksum, ledgerFingerprint: run.ledgerFingerprint } })
        return { ...run, payload: JSON.parse(run.payload) }
      })
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002') || attempt === 2) throw error
      const raced = await prisma.hgbCloseRun.findUnique({ where: { ownerId_checksum: { ownerId, checksum } } })
      if (raced) return { ...raced, payload: JSON.parse(raced.payload) }
    }
  }
  throw new ComplianceRuntimeError('HGB close run version allocation failed', 409)
}

export async function requireCurrentReadyHgbClose(transaction: Prisma.TransactionClient, ownerId: string, fiscalYear: { id: string; year: number }) {
  const latest = await transaction.hgbCloseRun.findFirst({ where: { ownerId, fiscalPeriodId: fiscalYear.id }, orderBy: { version: 'desc' } })
  if (!latest || latest.status !== 'READY_TO_LOCK') throw new AccountingValidationError(['A current READY_TO_LOCK HGB close run is required.'])
  if (sha256(latest.payload) !== latest.checksum) throw new AccountingValidationError(['The latest HGB close run checksum is invalid.'])
  const immutable = record(JSON.parse(latest.payload), 'Stored HGB close run')
  const storedInput = record(immutable.input, 'Stored HGB close input')
  if (sha256(canonicalJson(storedInput)) !== latest.inputChecksum) throw new AccountingValidationError(['The latest HGB close run input checksum is invalid.'])
  const packageId = typeof storedInput.annualAccountsPackageId === 'string' ? storedInput.annualAccountsPackageId : ''
  const packageChecksum = typeof storedInput.annualAccountsChecksum === 'string' ? storedInput.annualAccountsChecksum : ''
  const annualPackage = await transaction.compliancePackage.findFirst({ where: { id: packageId, ownerId, fiscalPeriodId: fiscalYear.id, kind: 'ANNUAL_ACCOUNTS', status: 'APPROVED', checksum: packageChecksum }, select: { id: true } })
  if (!annualPackage) throw new AccountingValidationError(['The approved annual-accounts package bound to the HGB close run is no longer authoritative.'])
  const context = await loadAuthoritativeContext(transaction, ownerId, fiscalYear.year, referencedEvidenceIds(storedInput))
  if (context.fiscalPeriod.id !== fiscalYear.id || context.missingEvidenceIds.length || context.invalidWorkpaperIds.length || context.ledgerFingerprint !== latest.ledgerFingerprint) throw new AccountingValidationError(['The latest HGB close run is stale because ledger, profile, mappings, workpapers, or retained evidence changed.'])
  return latest
}
