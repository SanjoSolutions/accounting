import 'server-only'

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Prisma } from '@/generated/prisma/client'
import { canonicalJson } from '@/core/compliance/auditExport'
import { createAssetSchedules, type AssetEvent, type FixedAsset } from '@/core/compliance/assetsInventory'
import { createAuthoritativeEBalanceDataset, eBalanceChecksum, reconciliationChecksum, validateTaxBalanceEvidence, type EBalanceExportDataset, type EBalanceTaxBalanceEvidence } from '@/core/eBilanzExport'
import { serializeEBalanceFilingXml } from '@/core/eBilanzFilingXml'
import { selectOfficialEBalanceTaxonomy } from '@/core/eBilanzTaxonomy'
import { readEBalanceTaxonomy } from '@/core/eBilanzTaxonomyModel'
import type { LedgerBalance } from '@/core/doubleEntry'
import type { EBalanceMasterData } from '@/core/eBilanz'
import { deriveEBalanceReportScope } from '@/core/eBilanzReportScope'
import { prisma } from '@/server/persistence/client'
import { requireCurrentFiscalCloseGeneration } from '@/server/fiscalCloseGeneration'
import { profilePayloadWithConfirmedAddress, validateCompanyProfile, type CompanyProfile } from './companyProfile'
import { appendAuditEvent } from './auditPersistence'
import { validateEBalanceFilingXml } from './eBilanzSchemaValidation'

type Client = Prisma.TransactionClient | typeof prisma
const date = (value: Date) => value.toISOString().slice(0, 10)

async function loadSource(client: Client, ownerId: string, fiscalYearId: string) {
  const period = await client.fiscalYear.findFirst({ where: { ownerId, id: fiscalYearId } })
  if (!period) throw new Error('Fiscal period not found.')
  const generation = await requireCurrentFiscalCloseGeneration(client, ownerId, period)
  const profile = await client.companyProfileVersion.findFirst({ where: { ownerId, effectiveFrom: { lte: period.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.endsAt } }] }, orderBy: { effectiveFrom: 'desc' } })
  if (!profile) throw new Error('An effective versioned company profile is required for filing export.')
  const confirmation = await client.companyProfileAddressConfirmation.findUnique({ where: { profileVersionId: profile.id } })
  const profilePayload = profilePayloadWithConfirmedAddress(profile.payload, confirmation?.payload)
  const parsedProfile = JSON.parse(profilePayload) as CompanyProfile
  if (validateCompanyProfile(parsedProfile).length || !parsedProfile.registeredAddress || !['UG', 'GMBH', 'AG'].includes(parsedProfile.legalForm)) throw new Error('A complete domestic UG/GmbH/AG company profile is required.')
  const reporting = parsedProfile.eBilanz
  if (parsedProfile.registeredAddress.country !== 'DE') throw new Error('The configured reporting scope requires an unsupported E-Bilanz variant.')
  deriveEBalanceReportScope(parsedProfile.legalForm as EBalanceMasterData['legalForm'], reporting)
  const [assets, events] = await Promise.all([
    client.fixedAssetRecord.findMany({ where: { ownerId }, orderBy: { id: 'asc' } }),
    client.assetEventRecord.findMany({ where: { ownerId }, orderBy: [{ assetId: 'asc' }, { sequence: 'asc' }] }),
  ])
  const sourceChecksum = eBalanceChecksum(canonicalJson({ ownerId, fiscalYearId, closeGenerationId: generation.id, snapshotHash: generation.snapshotHash,
    profileVersionId: profile.id, profilePayload, assets: assets.map(row => ({ id: row.id, payload: row.payload })), events: events.map(row => ({ id: row.id, payload: row.payload })) }))
  const company: EBalanceMasterData = { companyName: parsedProfile.companyName, taxNumber: parsedProfile.taxNumber, legalForm: parsedProfile.legalForm as 'UG' | 'GMBH' | 'AG',
    street: parsedProfile.registeredAddress.streetAndHouseNumber, postalCode: parsedProfile.registeredAddress.zipCode, city: parsedProfile.registeredAddress.city }
  return { period, generation, profilePayload, company, reporting, assets, events, sourceChecksum, activity: parsedProfile.activity }
}

function reconciliationEvidenceIds(payload: EBalanceTaxBalanceEvidence) {
  return [...payload.adjustments.flatMap(row => row.evidenceIds), ...(payload.attachments ?? []).flatMap(row => row.status === 'PRESENT' ? row.evidenceIds : [])]
}

async function requireRevisionPredecessor(client: Client, ownerId: string, fiscalYearId: string, payload: EBalanceTaxBalanceEvidence) {
  const previous = payload.revision?.supersedes
  if (!previous) return
  const report = await client.eBalanceLifecycleReport.findFirst({ where: { id: previous.reportId, ownerId, fiscalYearId }, select: { reportChecksum: true, reportXml: true } })
  if (!report || report.reportChecksum !== previous.reportChecksum || eBalanceChecksum(report.reportXml) !== previous.reportChecksum) throw new Error('Revision predecessor is missing, changed or belongs to another tenant or fiscal period.')
}

async function requireEvidence(client: Client, ownerId: string, ids: string[]) {
  const unique = [...new Set(ids)]
  const [artifacts, documents] = await Promise.all([
    client.retainedArtifact.findMany({ where: { ownerId, id: { in: unique }, disposedAt: null, storageDeletedAt: null }, select: { id: true, contentHash: true } }),
    client.documentRecord.findMany({ where: { ownerId, id: { in: unique } }, select: { id: true, payload: true } }),
  ])
  const found = new Map([...artifacts.map(row => [row.id, row.contentHash] as const), ...documents.map(row => [row.id, eBalanceChecksum(row.payload)] as const)])
  if (unique.some(id => !found.has(id))) throw new Error('Reconciliation evidence is missing, disposed or belongs to another tenant.')
  return [...found].sort(([a], [b]) => a.localeCompare(b))
}

export async function recordTaxBalanceReconciliation(ownerId: string, actorId: string, input: Record<string, unknown>) {
  if (typeof input.fiscalYearId !== 'string' || typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('Fiscal period and approval reason are required.')
  const fiscalYearId = input.fiscalYearId
  const reason = input.reason.trim()
  return prisma.$transaction(async transaction => {
    const source = await loadSource(transaction, ownerId, fiscalYearId)
    // The user must name the generation reviewed; the server supplies the source hash.
    const supplied = structuredClone(input.payload) as EBalanceTaxBalanceEvidence
    if (!supplied || supplied.closeGenerationId !== source.generation.id) throw new Error('Approve the current exact close generation explicitly.')
    const evidenceIds = input.evidenceIds as string[]
    if (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Approval evidence is required.')
    if (!Array.isArray(supplied.adjustments)) throw new Error('Tax adjustments must be explicit, including an empty list when none apply.')
    const references = [...evidenceIds, ...reconciliationEvidenceIds(supplied)]
    const evidence = await requireEvidence(transaction, ownerId, references)
    const payload = validateTaxBalanceEvidence({ ...supplied, sourceChecksum: source.sourceChecksum, evidenceChecksum: eBalanceChecksum(canonicalJson(evidence)) })
    await requireRevisionPredecessor(transaction, ownerId, fiscalYearId, payload)
    if (payload.gcd.business !== source.activity) throw new Error('Reconciliation business activity must match the effective company profile.')
    const checksum = reconciliationChecksum(ownerId, fiscalYearId, payload, evidenceIds)
    const latest = await transaction.eBalanceReconciliationRecord.findFirst({ where: { ownerId, fiscalYearId, kind: 'TAX_BALANCE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    const id = randomUUID()
    const approvedAt = new Date(Math.max(Date.now(), (latest?.createdAt.getTime() ?? 0) + 1))
    const record = await transaction.eBalanceReconciliationRecord.create({ data: { id, ownerId, fiscalYearId, kind: 'TAX_BALANCE',
      payload: canonicalJson(payload), checksum, evidenceIds: canonicalJson(evidenceIds), approvedBy: actorId, approvedAt, createdAt: approvedAt } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'E_BILANZ_TAX_BALANCE_APPROVED', reason, objectType: 'EBalanceReconciliationRecord', objectId: id,
      after: { closeGenerationId: source.generation.id, sourceChecksum: source.sourceChecksum, checksum, evidence, supersedesId: latest?.id ?? null } })
    return record
  })
}

export async function prepareAuthoritativeEBalanceExport(ownerId: string, fiscalYearId: string, options: { taxonomyVersion?: string; taxonomyPreparation?: 'LOCAL'; remoteSchemaReferences?: boolean; asOf?: string } = {}) {
  // Capture all authoritative inputs through one transaction. The public caller
  // rechecks the captured fingerprint in its own final publication transaction.
  const captured = await prisma.$transaction(async transaction => {
    const source = await loadSource(transaction, ownerId, fiscalYearId)
    const reconciliation = await transaction.eBalanceReconciliationRecord.findFirst({ where: { ownerId, fiscalYearId, kind: 'TAX_BALANCE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    if (!reconciliation) throw new Error('An approved complete tax-balance reconciliation for this close generation is required.')
    const payload = validateTaxBalanceEvidence(JSON.parse(reconciliation.payload))
    await requireRevisionPredecessor(transaction, ownerId, fiscalYearId, payload)
    if (payload.gcd.business !== source.activity) throw new Error('Reconciliation business activity differs from the authoritative profile.')
    const evidenceIds = JSON.parse(reconciliation.evidenceIds) as string[]
    const evidence = await requireEvidence(transaction, ownerId, [...evidenceIds, ...reconciliationEvidenceIds(payload)])
    if (eBalanceChecksum(canonicalJson(evidence)) !== payload.evidenceChecksum) throw new Error('Approved reconciliation evidence has changed.')
    return { ...source, reconciliation, payload, evidenceIds, evidence }
  })
  const { period, generation } = captured
  const taxonomy = selectOfficialEBalanceTaxonomy(date(period.startsAt), { asOf: options.asOf ?? date(new Date()), requestedVersion: options.taxonomyVersion, receiver: options.taxonomyPreparation })
  const officialArchive = await readFile(path.join(process.cwd(), 'public/taxonomies', taxonomy.archiveFile))
  const model = readEBalanceTaxonomy(taxonomy, officialArchive)
  const periodDates = { start: date(period.startsAt), end: date(period.endsAt) }
  const masters = captured.assets.map(row => JSON.parse(row.payload) as FixedAsset)
  const events = captured.events.map(row => JSON.parse(row.payload) as AssetEvent)
  const book = createAssetSchedules(ownerId, masters, events, periodDates)
  const tax = createAssetSchedules(ownerId, masters.map(asset => ({ ...asset, method: asset.taxMethod, usefulLifeMonths: asset.taxUsefulLifeMonths })),
    events.map(event => ({ ...event, bookAmountCents: event.taxAmountCents ?? event.amountCents })), periodDates)
  const snapshot = JSON.parse(period.closingSnapshot!) as { balances: LedgerBalance[] }
  const dataset = createAuthoritativeEBalanceDataset({ ownerId, sourceChecksum: captured.sourceChecksum,
    fiscalYear: { id: period.id, year: period.year, startsAt: date(period.startsAt), endsAt: date(period.endsAt) },
    closeGeneration: { id: generation.id, snapshotHash: generation.snapshotHash, hgbCloseRunChecksum: generation.hgbCloseRunChecksum, lockedAt: generation.lockedAt.toISOString() },
    company: captured.company, reportProfile: captured.reporting, balances: snapshot.balances,
    reconciliation: { id: captured.reconciliation.id, ownerId, fiscalYearId, checksum: captured.reconciliation.checksum, approvedBy: captured.reconciliation.approvedBy,
      approvedAt: captured.reconciliation.approvedAt.toISOString(), evidenceIds: captured.evidenceIds, payload: captured.payload },
    assets: book.eBalanceAttachments.assetSchedule.rows.map(row => ({ book: row, tax: tax.eBalanceAttachments.assetSchedule.rows.find(item => item.assetId === row.assetId)!, acquisitionDate: masters.find(asset => asset.id === row.assetId)!.acquisitionDate })),
  }, model)
  const xml = serializeEBalanceFilingXml(dataset, options.remoteSchemaReferences)
  const diagnostics = await validateEBalanceFilingXml(xml, dataset, officialArchive)
  return { dataset, datasetChecksum: eBalanceChecksum(canonicalJson(dataset)), xml, reportChecksum: eBalanceChecksum(xml), officialArchive, diagnostics, evidenceChecksum: eBalanceChecksum(canonicalJson(captured.evidence)) }
}

export async function assertCurrentEBalanceExport(client: Client, ownerId: string, prepared: { dataset: EBalanceExportDataset; evidenceChecksum: string }) {
  if (prepared.dataset.ownerId !== ownerId) throw new Error('E-Bilanz tenant mismatch.')
  const source = await loadSource(client, ownerId, prepared.dataset.fiscalYear.id)
  const latest = await client.eBalanceReconciliationRecord.findFirst({ where: { ownerId, fiscalYearId: source.period.id, kind: 'TAX_BALANCE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  if (source.generation.id !== prepared.dataset.closeGenerationId || source.sourceChecksum !== prepared.dataset.sourceChecksum || latest?.id !== prepared.dataset.reconciliation.id || latest.checksum !== prepared.dataset.reconciliation.checksum) throw new Error('The close generation or reconciliation changed during E-Bilanz preparation.')
  const reconciliation = prepared.dataset.reconciliation
  await requireRevisionPredecessor(client, ownerId, source.period.id, reconciliation.payload)
  const evidence = await requireEvidence(client, ownerId, [...reconciliation.evidenceIds, ...reconciliationEvidenceIds(reconciliation.payload)])
  if (eBalanceChecksum(canonicalJson(evidence)) !== prepared.evidenceChecksum) throw new Error('E-Bilanz reconciliation evidence changed during preparation.')
  return source.generation
}

export function serializePreparedEBalanceEvidence(prepared: Awaited<ReturnType<typeof prepareAuthoritativeEBalanceExport>>) {
  return canonicalJson({ format: 'OFFICIAL_XBRL', dataset: prepared.dataset, datasetChecksum: prepared.datasetChecksum, evidenceChecksum: prepared.evidenceChecksum, diagnostics: prepared.diagnostics })
}

/** Legacy internal evidence is retained, but can never become a current filing. */
export async function assertCurrentEBalanceReport(client: Client, ownerId: string, report: { reportPayload: string; reportXml: string; reportChecksum: string; closeGenerationId: string | null }) {
  const payload = JSON.parse(report.reportPayload) as { format?: string; dataset?: EBalanceExportDataset; datasetChecksum?: string; evidenceChecksum?: string; diagnostics?: { reportChecksum?: string; level?: string; valid?: boolean } } | null
  if (payload?.format !== 'OFFICIAL_XBRL' || payload.dataset?.schemaVersion !== 'EBILANZ_EXPORT_V1' || typeof payload.evidenceChecksum !== 'string'
    || payload.dataset.closeGenerationId !== report.closeGenerationId
    || payload.datasetChecksum !== eBalanceChecksum(canonicalJson(payload.dataset))
    || payload.diagnostics?.reportChecksum !== report.reportChecksum || eBalanceChecksum(report.reportXml) !== report.reportChecksum
    || payload.diagnostics?.level !== 'LOCAL_STRUCTURAL' || payload.diagnostics?.valid !== true) throw new Error('Report has no verified official filing dataset. Regenerate the retained internal evidence.')
  if (report.reportXml !== serializeEBalanceFilingXml(payload.dataset) && report.reportXml !== serializeEBalanceFilingXml(payload.dataset, true)) throw new Error('Report XML differs from its retained dataset.')
  await assertCurrentEBalanceExport(client, ownerId, { dataset: payload.dataset, evidenceChecksum: payload.evidenceChecksum })
}
