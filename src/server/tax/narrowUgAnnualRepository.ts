import 'server-only'

import { canonicalJson } from '@/core/compliance/auditExport'
import { TaxDeclarationError, declarationDatasetHash, taxFormRegistry, type DeclarationDataset } from '@/core/taxDeclarations'
import { prepareCapitalCompanyDeclaration, type CapitalCompanyAdjustment } from '@/core/simpleCapitalCompanyDeclaration'
import { CAPITAL_COMPANY_RULES, capitalCompanyRuleVersion, type CapitalCompanyFacts, type CapitalCompanyYear } from '@/core/simpleCapitalCompanyTax'
import { annualAdjustmentRules } from '@/core/annualTax'
import { prisma } from '@/server/persistence/client'
import { requireCurrentFiscalCloseGeneration } from '@/server/fiscalCloseGeneration'
import { sha256 } from '@/server/compliance/retention'
import { companyProfileForPeriod } from './profileRepository'

const unsupportedFacts = ['foreignIncome', 'groupOrConsolidation', 'lossCarry', 'specialRegime', 'withholdingOrCredits', 'payroll'] as const

export function exactNarrowCapitalCompanyFacts(profile: Awaited<ReturnType<typeof companyProfileForPeriod>>, year: number): CapitalCompanyFacts {
  const facts = profile.annualTaxProfile
  if (!(year in CAPITAL_COMPANY_RULES) || !['UG', 'GMBH'].includes(profile.legalForm) || !facts || facts.tradeBusiness !== true || facts.establishments !== 1 || !/^\d{8}$/.test(facts.municipalityCode ?? '') || !Number.isSafeInteger(facts.tradeTaxMultiplierBasisPoints) || facts.tradeTaxMultiplierBasisPoints! < 20000) throw new TaxDeclarationError(['The narrow annual workflow supports only a 2025/2026 German UG or GmbH, one municipality and one trade-tax establishment with a canonical Hebesatz.'])
  const missing = unsupportedFacts.filter(field => facts[field] !== false)
  if (missing.length) throw new TaxDeclarationError([`Unsupported or unconfirmed annual tax facts fail closed: ${missing.join(', ')}.`])
  return { legalForm: profile.legalForm as 'UG' | 'GMBH', year: year as CapitalCompanyYear, establishments: 1, municipalityCode: facts.municipalityCode!, hebesatzBasisPoints: facts.tradeTaxMultiplierBasisPoints!, foreignIncome: false, groupOrConsolidation: false, lossCarry: false, specialRegime: false, withholdingOrCredits: false, payroll: false }
}

export function exactNarrowUg2025Facts(profile: Awaited<ReturnType<typeof companyProfileForPeriod>>) {
  const facts = exactNarrowCapitalCompanyFacts(profile, 2025)
  if (facts.legalForm !== 'UG') throw new TaxDeclarationError(['The backward-compatible 2025 UG entry point requires legal form UG.'])
  return facts as CapitalCompanyFacts & { legalForm: 'UG'; year: 2025 }
}

function signedAdjustment(row: { id: string; layer: string; amountCents: number; ruleVersion: string; field: string; sourceDocumentIds: string; treatment: string; reason: string; legalBasis: string }, year: CapitalCompanyYear): CapitalCompanyAdjustment {
  let evidenceIds: unknown
  try { evidenceIds = JSON.parse(row.sourceDocumentIds) } catch { throw new TaxDeclarationError([`Adjustment ${row.id} has invalid evidence provenance.`]) }
  if (!Array.isArray(evidenceIds) || evidenceIds.some(id => typeof id !== 'string')) throw new TaxDeclarationError([`Adjustment ${row.id} has invalid evidence provenance.`])
  const rule = annualAdjustmentRules.resolve(row.ruleVersion, String(year))
  if (!rule || rule.layer !== row.layer || rule.field !== row.field || rule.legalBasis !== row.legalBasis || rule.treatment !== row.treatment || !row.reason.trim()) throw new TaxDeclarationError([`Adjustment ${row.id} does not match an authoritative ${year} adjustment rule.`])
  if (row.treatment === 'add-back' && row.amountCents < 0 || row.treatment === 'deduction' && row.amountCents > 0) throw new TaxDeclarationError([`Adjustment ${row.id} sign does not match its treatment.`])
  return { id: row.id, layer: rule.layer, amountCents: row.amountCents, ruleVersion: row.ruleVersion, field: rule.field as CapitalCompanyAdjustment['field'], reason: row.reason, legalBasis: row.legalBasis, treatment: rule.treatment, evidenceIds }
}

async function build(ownerId: string, year: CapitalCompanyYear) {
  const period = await prisma.fiscalYear.findFirst({ where: { ownerId, year }, select: { id: true, year: true, startsAt: true, endsAt: true, status: true, lockedAt: true, closingSnapshot: true } })
  if (!period) throw new TaxDeclarationError([`Configure the ${year} fiscal year first.`])
  if (period.startsAt.toISOString().slice(0, 10) !== `${year}-01-01` || period.endsAt.toISOString().slice(0, 10) !== `${year}-12-31`) throw new TaxDeclarationError(['The narrow capital-company annual workflow requires an exact calendar-year fiscal period.'])
  const close = await requireCurrentFiscalCloseGeneration(prisma, ownerId, period)
  const profile = await companyProfileForPeriod(ownerId, period.startsAt, period.endsAt)
  const facts = exactNarrowCapitalCompanyFacts(profile, year)
  let snapshot: unknown
  try { snapshot = JSON.parse(period.closingSnapshot!) } catch { throw new TaxDeclarationError(['The exact locked HGB closing snapshot is invalid.']) }
  const hgbResultCents = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? (snapshot as Record<string, unknown>).netIncomeCents : undefined
  if (!Number.isSafeInteger(hgbResultCents)) throw new TaxDeclarationError(['The exact locked HGB closing snapshot has no canonical net result.'])
  const eBalance = await prisma.eBalanceLifecycleReport.findFirst({ where: { ownerId, fiscalYearId: period.id, closeGenerationId: close.id, status: { in: ['PREPARED', 'EXPORTED', 'VALIDATED', 'APPROVED', 'SUBMITTED', 'ACCEPTED'] } }, orderBy: { version: 'desc' } })
  if (!eBalance) throw new TaxDeclarationError(['Prepare an E-Bilanz report bound to the exact locked HGB close before annual tax preparation.'])
  const rows = await prisma.taxAdjustmentRecord.findMany({ where: { ownerId, year }, orderBy: { createdAt: 'asc' } })
  const adjustments = rows.map(row => signedAdjustment(row, year))
  let preparation
  try { preparation = prepareCapitalCompanyDeclaration({ closeGenerationId: close.id, hgbCloseRunChecksum: close.hgbCloseRunChecksum, closingSnapshotHash: close.snapshotHash, eBalanceArtifactId: eBalance.id, eBalanceArtifactHash: eBalance.reportChecksum, hgbResultCents: hgbResultCents as number }, facts, adjustments) }
  catch (error) { throw new TaxDeclarationError([error instanceof Error ? error.message : 'The narrow annual tax preparation failed closed.']) }
  const datasets = preparation.datasets.map(input => taxFormRegistry.prepare(input.kind, input.period, { ...input.fields }, { ...input.drilldown }, ownerId))
  const source = { closeGenerationId: close.id, hgbCloseRunId: close.hgbCloseRunId, hgbCloseRunChecksum: close.hgbCloseRunChecksum, snapshotHash: close.snapshotHash, eBalanceReportId: eBalance.id, eBalanceReportChecksum: eBalance.reportChecksum, facts, adjustments, preview: preparation.preview }
  return { period, close, facts, adjustments, preparation, datasets, source, sourceChecksum: sha256(canonicalJson(source)) }
}

export async function prepareNarrowCapitalCompanyAnnualTax(ownerId: string, actorId: string, requestedYear: number) {
  if (!(requestedYear in CAPITAL_COMPANY_RULES)) throw new TaxDeclarationError(['The narrow capital-company annual workflow supports only 2025 and 2026.'])
  const year = requestedYear as CapitalCompanyYear
  const current = await build(ownerId, year)
  const existing = await prisma.taxAnnualCaseRecord.findUnique({ where: { ownerId_sourceChecksum: { ownerId, sourceChecksum: current.sourceChecksum } } })
  if (existing) {
    const rows = await prisma.taxDatasetPreparationRecord.findMany({ where: { ownerId, annualCaseId: existing.id }, orderBy: { kind: 'asc' } })
    return { caseId: existing.id, authority: current.preparation.authority, notice: current.preparation.notice, ruleVersion: current.preparation.ruleVersion, preview: current.preparation.preview, datasets: current.datasets, preparationIds: rows.map(row => row.id) }
  }
  return prisma.$transaction(async transaction => {
    const annualCase = await transaction.taxAnnualCaseRecord.create({ data: {
      ownerId, year, closeGenerationId: current.close.id, status: 'PREPARED', ruleVersion: current.preparation.ruleVersion, legalForm: current.facts.legalForm, establishments: 1,
      municipalityCode: current.facts.municipalityCode, hebesatzBasisPoints: current.facts.hebesatzBasisPoints,
      foreignIncome: false, groupOrConsolidation: false, lossCarry: false, specialRegime: false, withholdingOrCredits: false, payroll: false,
      incomeAdjustmentCents: current.adjustments.filter(item => item.layer === 'income-tax').reduce((sum, item) => sum + item.amountCents, 0), tradeAdjustmentCents: current.adjustments.filter(item => item.layer === 'trade-tax').reduce((sum, item) => sum + item.amountCents, 0),
      previewPayload: canonicalJson({ authority: current.preparation.authority, notice: current.preparation.notice, preview: current.preparation.preview }), sourceChecksum: current.sourceChecksum, createdBy: actorId,
    } })
    const preparations = []
    for (const dataset of current.datasets) {
      const datasetHash = declarationDatasetHash(dataset)
      const collision = await transaction.taxDatasetPreparationRecord.findUnique({ where: { ownerId_datasetHash: { ownerId, datasetHash } } })
      if (collision) throw new TaxDeclarationError(['The exact declaration dataset is already bound to a different annual preparation.'])
      preparations.push(await transaction.taxDatasetPreparationRecord.create({ data: { ownerId, kind: dataset.kind, period: dataset.period, datasetHash, sourcePayload: canonicalJson(current.source), datasetPayload: canonicalJson(dataset), sourceChecksum: current.sourceChecksum, ruleVersion: current.preparation.ruleVersion, bindingKind: 'EXACT_LOCKED_HGB_CLOSE', closeGenerationId: current.close.id, annualCaseId: annualCase.id } }))
    }
    return { caseId: annualCase.id, authority: current.preparation.authority, notice: current.preparation.notice, ruleVersion: current.preparation.ruleVersion, preview: current.preparation.preview, datasets: current.datasets, preparationIds: preparations.map(row => row.id) }
  })
}

export function prepareNarrowUgAnnualTax(ownerId: string, actorId: string) { return prepareNarrowCapitalCompanyAnnualTax(ownerId, actorId, 2025) }

export async function revalidateNarrowUgAnnualDataset(ownerId: string, dataset: DeclarationDataset) {
  const prepared = await prisma.taxDatasetPreparationRecord.findUnique({ where: { ownerId_datasetHash: { ownerId, datasetHash: declarationDatasetHash(dataset) } } })
  if (prepared?.bindingKind !== 'EXACT_LOCKED_HGB_CLOSE' || !prepared.closeGenerationId || !prepared.annualCaseId) return false
  const year = Number(dataset.period)
  if (!(year in CAPITAL_COMPANY_RULES)) return false
  const current = await build(ownerId, year as CapitalCompanyYear)
  if (prepared.ruleVersion !== capitalCompanyRuleVersion(current.facts)) return false
  const match = current.datasets.find(item => item.kind === dataset.kind && item.period === dataset.period)
  if (!match || declarationDatasetHash(match) !== declarationDatasetHash(dataset) || current.close.id !== prepared.closeGenerationId || current.sourceChecksum !== prepared.sourceChecksum) throw new TaxDeclarationError(['The locked close, E-Bilanz, profile or evidenced tax adjustments changed; prepare and approve a new annual dataset.'])
  return true
}
