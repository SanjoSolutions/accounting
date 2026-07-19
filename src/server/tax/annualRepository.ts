import 'server-only'

import {
  annualReturnDeadline,
  applicableAnnualReturns,
  attestAnnualTaxLiability,
  createConfiguredAnnualTaxLiabilityAuthority,
  parseAnnualTaxValues,
  parseAnnualTaxYear,
  prepareAnnualReturns,
  reconcileAnnualTax,
  type AnnualTaxProfile,
  type AnnualTaxValue,
  type TaxAdjustment,
} from '@/core/annualTax'
import { declarationDatasetHash, TaxDeclarationError, taxFormRegistry, type DeclarationDataset } from '@/core/taxDeclarations'
import { prisma } from '@/server/persistence/client'
import { getLedgerWorkspace } from '@/server/ledger'
import { SaxesParser } from 'saxes'
import { companyProfileForPeriod } from './profileRepository'
import { secureServiceEndpoint } from './transport'
import { isPrismaInt } from './persistenceLimits'

function mapLegalForm(value: string): AnnualTaxProfile['legalForm'] {
  if (value === 'GMBH' || value === 'UG' || value === 'AG' || value === 'GBR' || value === 'OHG' || value === 'KG' || value === 'GMBH_CO_KG') return value
  if (value === 'SOLE_TRADER') return 'SOLE_PROPRIETOR'
  throw new TaxDeclarationError([`Legal form ${value || '(missing)'} is not supported for annual tax filing.`])
}

export async function annualTaxApplicability(ownerId: string, year: number) {
  year = parseAnnualTaxYear(year)
  const fiscalYear = await prisma.fiscalYear.findFirst({ where: { ownerId, year }, select: { startsAt: true, endsAt: true } })
  if (!fiscalYear) throw new TaxDeclarationError(['Configure the tenant fiscal year before annual tax preparation.'])
  const stored = await companyProfileForPeriod(ownerId, fiscalYear.startsAt, fiscalYear.endsAt)
  const facts = stored.annualTaxProfile!
  if (!facts || typeof facts.tradeBusiness !== 'boolean' || !Number.isSafeInteger(facts.establishments) || facts.establishments < 1 || typeof facts.adviserExtension !== 'boolean') throw new TaxDeclarationError(['Configure canonical trade-business, establishment and adviser facts in the tenant annual tax profile.'])
  const profile: AnnualTaxProfile = {
    companyId: ownerId, legalForm: mapLegalForm(stored.legalForm!), tradeBusiness: facts.tradeBusiness,
    establishments: facts.establishments, adviserExtension: facts.adviserExtension,
    fiscalYearEnd: fiscalYear.endsAt.toISOString().slice(0, 10), municipalityCode: facts.municipalityCode,
    tradeTaxMultiplierBasisPoints: facts.tradeTaxMultiplierBasisPoints,
    establishmentAllocations: facts.establishmentAllocations,
  }
  return { profile, kinds: applicableAnnualReturns(profile), deadline: annualReturnDeadline(year, profile), professionalValidationRequired: true }
}

export function parseTaxAdjustmentInput(value: unknown): Omit<TaxAdjustment, 'effectiveFor'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TaxDeclarationError(['A complete tax adjustment is required.'])
  const adjustment = value as Partial<Omit<TaxAdjustment, 'effectiveFor'>>
  const identifiers = [adjustment.id, adjustment.ruleVersion, adjustment.field, adjustment.reason, adjustment.legalBasis]
  if (identifiers.some(item => typeof item !== 'string' || !item.trim())) throw new TaxDeclarationError(['Adjustment identifiers, field, reason, rule version and legal basis are required.'])
  if (!['income-tax', 'trade-tax'].includes(adjustment.layer ?? '')) throw new TaxDeclarationError(['Adjustment layer must be income-tax or trade-tax.'])
  if (!isPrismaInt(adjustment.amountCents)) throw new TaxDeclarationError(['Adjustment amount must fit signed 32-bit integer cents storage.'])
  if (!['add-back', 'deduction'].includes(adjustment.treatment ?? '')) throw new TaxDeclarationError(['Adjustment treatment must be add-back or deduction.'])
  if (!Array.isArray(adjustment.sourceDocumentIds) || !adjustment.sourceDocumentIds.length || adjustment.sourceDocumentIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(adjustment.sourceDocumentIds).size !== adjustment.sourceDocumentIds.length) throw new TaxDeclarationError(['A tax adjustment requires unique non-empty source document IDs.'])
  return adjustment as Omit<TaxAdjustment, 'effectiveFor'>
}

export async function saveTaxAdjustment(ownerId: string, year: number, value: unknown) {
  year = parseAnnualTaxYear(year)
  const adjustment = parseTaxAdjustmentInput(value)
  if (!adjustment.sourceDocumentIds.length) throw new TaxDeclarationError(['A tax adjustment requires source documents.'])
  const count = await prisma.documentRecord.count({ where: { ownerId, id: { in: [...adjustment.sourceDocumentIds] } } })
  if (count !== new Set(adjustment.sourceDocumentIds).size) throw new TaxDeclarationError(['Every adjustment source document must belong to this tenant.'])
  return prisma.taxAdjustmentRecord.create({ data: {
    id: adjustment.id, ownerId, year, ruleVersion: adjustment.ruleVersion, field: adjustment.field,
    layer: adjustment.layer, amountCents: adjustment.amountCents, reason: adjustment.reason,
    sourceDocumentIds: JSON.stringify(adjustment.sourceDocumentIds), legalBasis: adjustment.legalBasis,
    treatment: adjustment.treatment,
  } })
}

function annualCalculator() {
  const configuredEndpoint = process.env.ANNUAL_TAX_CALCULATOR_URL
  const credential = process.env.ANNUAL_TAX_CALCULATOR_CREDENTIAL
  if (!configuredEndpoint || !credential) throw new TaxDeclarationError(['Configure the annual tax calculation authority before preparing liability fields.'])
  let endpoint: string
  try { endpoint = secureServiceEndpoint(configuredEndpoint, 'ANNUAL_TAX_CALCULATOR_URL') } catch (error) { throw new TaxDeclarationError([error instanceof Error ? error.message : 'The annual tax calculation authority URL is invalid.']) }
  return createConfiguredAnnualTaxLiabilityAuthority({ attest: async claim => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` }, body: JSON.stringify(claim), signal: AbortSignal.timeout(60_000) })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok || !body || typeof body !== 'object' || Array.isArray(body)) return { verified: false }
    const value = body as Record<string, unknown>
    return { verified: value.verified === true, calculationId: typeof value.calculationId === 'string' ? value.calculationId : undefined }
  } }, `annual-tax-calculator:${endpoint}`)
}

async function buildAnnualTaxDatasets(ownerId: string, year: number, values: readonly AnnualTaxValue[], persist: boolean) {
  year = parseAnnualTaxYear(year)
  values = parseAnnualTaxValues(values)
  const { profile, deadline } = await annualTaxApplicability(ownerId, year)
  const workspace = await getLedgerWorkspace(ownerId, year)
  if (workspace.entries.some(entry => entry.state !== 'POSTED')) throw new TaxDeclarationError(['Binding annual preparation requires every journal entry in the fiscal year to be immutable and posted.'])
  const resultEntryIds = deriveAnnualResultEntryIds(workspace.entries)
  const resultFields = new Set(['HGB_RESULT', 'STEUERLICHES_ERGEBNIS', 'GEWERBEERTRAG'])
  const unsupportedProvenance = values.filter(value => resultFields.has(value.field) && !sameIdentifiers(value.ledgerEntryIds, resultEntryIds))
  if (unsupportedProvenance.length) throw new TaxDeclarationError(['Annual result drilldown must exactly contain every tenant ledger entry contributing to revenue or expense and no unrelated entries.'])
  values = values.map(value => resultFields.has(value.field) ? { ...value, ledgerEntryIds: resultEntryIds } : value)
  const rows = await prisma.taxAdjustmentRecord.findMany({ where: { ownerId, year } })
  const adjustments: TaxAdjustment[] = rows.map(row => ({
    id: row.id, ruleVersion: row.ruleVersion, effectiveFor: String(year), field: row.field,
    layer: row.layer as TaxAdjustment['layer'], amountCents: row.amountCents, reason: row.reason,
    sourceDocumentIds: JSON.parse(row.sourceDocumentIds), legalBasis: row.legalBasis, treatment: row.treatment as TaxAdjustment['treatment'],
  }))
  const ledgerEntryIds = [...new Set(values.flatMap(value => [...value.ledgerEntryIds]))]
  const ownedLedgerEntries = await prisma.journalEntry.count({ where: { id: { in: ledgerEntryIds }, state: 'POSTED', fiscalYear: { ownerId, year } } })
  if (ownedLedgerEntries !== ledgerEntryIds.length) throw new TaxDeclarationError(['Every annual declaration ledger drilldown entry must belong to this tenant and fiscal year.'])
  const eBilanzFacts = [...new Set(values.flatMap(value => [...value.eBilanzFacts]))]
  const ownedEBilanzFacts = await prisma.eBalanceSubmission.findMany({ where: { ownerId, year, payloadHash: { in: eBilanzFacts }, status: { in: ['VALID', 'ACCEPTED'] } }, select: { payloadHash: true, requestXml: true } })
  validateEBilanzReferences(eBilanzFacts, ownedEBilanzFacts.map(fact => fact.payloadHash))
  const liabilityValues = values.filter(value => ['KST_SCHULD', 'GEWST_SCHULD', 'EST_SCHULD'].includes(value.field))
  const authority = liabilityValues.length ? annualCalculator() : undefined
  const liabilityEvidence = authority ? await Promise.all(liabilityValues.map(value => attestAnnualTaxLiability({ taxpayerId: ownerId, filingPeriod: String(year), field: value.field as 'KST_SCHULD' | 'GEWST_SCHULD' | 'EST_SCHULD', amountCents: value.amountCents }, authority))) : []
  const results = independentAnnualResults(values, workspace.statements.netIncomeCents)
  const hgbClaim = values.find(value => value.field === 'HGB_RESULT')!
  const eBilanzClaim = values.find(value => value.field === 'E_BILANZ_RESULT')!
  const eBilanzResultFacts = [...new Set(eBilanzClaim.eBilanzFacts)]
  const eBilanzArtifact = eBilanzResultFacts.length === 1 ? ownedEBilanzFacts.find(fact => fact.payloadHash === eBilanzResultFacts[0]) : undefined
  if (hgbClaim.amountCents !== workspace.statements.netIncomeCents || !eBilanzArtifact || extractEBilanzNetIncomeCents(eBilanzArtifact.requestXml) !== eBilanzClaim.amountCents) throw new TaxDeclarationError(['Annual result amounts must exactly match their ledger-backed HGB statement and officially valid E-Bilanz artifacts.'])
  const reconciliation = reconcileAnnualTax({ taxpayerId: ownerId, filingPeriod: String(year), ...results, adjustments, values, liabilityEvidence })
  const datasets = prepareAnnualReturns(year, profile, reconciliation, taxFormRegistry)
  const sourcePayload = JSON.stringify(values)
  if (persist) await prisma.$transaction(datasets.map(dataset => prisma.taxDatasetPreparationRecord.upsert({ where: { ownerId_datasetHash: { ownerId, datasetHash: declarationDatasetHash(dataset) } }, create: { ownerId, kind: dataset.kind, period: dataset.period, datasetHash: declarationDatasetHash(dataset), sourcePayload }, update: { sourcePayload } })))
  return { deadline, reconciliation, datasets, professionalValidationRequired: true }
}

export function prepareAnnualTaxDatasets(ownerId: string, year: number, values: readonly AnnualTaxValue[]) { return buildAnnualTaxDatasets(ownerId, year, values, true) }

export async function revalidatePreparedAnnualDataset(ownerId: string, dataset: DeclarationDataset) {
  const datasetHash = declarationDatasetHash(dataset)
  const prepared = await prisma.taxDatasetPreparationRecord.findUnique({ where: { ownerId_datasetHash: { ownerId, datasetHash } } })
  if (!prepared?.sourcePayload || prepared.kind !== dataset.kind || prepared.period !== dataset.period) throw new TaxDeclarationError(['Binding annual submission requires the exact current tenant-scoped prepared dataset.'])
  let source: unknown
  try { source = JSON.parse(prepared.sourcePayload) } catch { throw new TaxDeclarationError(['The annual preparation source snapshot is invalid.']) }
  const current = await buildAnnualTaxDatasets(ownerId, Number(dataset.period), parseAnnualTaxValues(source), false)
  const match = current.datasets.find(candidate => candidate.kind === dataset.kind && candidate.period === dataset.period)
  if (!match || declarationDatasetHash(match) !== datasetHash) throw new TaxDeclarationError(['The annual declaration sources changed after preparation; prepare and approve the current dataset again.'])
}

export function extractEBilanzNetIncomeCents(xml: string) {
  if (Buffer.byteLength(xml, 'utf8') > 20 * 1024 * 1024) throw new TaxDeclarationError(['The E-Bilanz artifact exceeds the bounded XML parsing limit.'])
  const facts: string[] = []; let depth = 0; let active: { depth: number; text: string; nested: boolean } | null = null
  try {
    const parser = new SaxesParser({ xmlns: true })
    parser.on('opentag', tag => {
      depth++
      if (active) active.nested = true
      if (tag.local === 'is.netIncome' && tag.uri.startsWith('http://www.xbrl.de/taxonomies/de-gaap-ci-')) {
        if (active) throw new Error('nested net-income fact')
        active = { depth, text: '', nested: false }
      }
    })
    parser.on('text', text => { if (active && depth === active.depth) active.text += text })
    parser.on('cdata', text => { if (active && depth === active.depth) active.text += text })
    parser.on('closetag', () => { if (active && depth === active.depth) { if (active.nested) throw new Error('nested monetary fact'); facts.push(active.text); active = null } depth-- })
    parser.write(xml).close()
  } catch { throw new TaxDeclarationError(['The E-Bilanz artifact must be well-formed namespace-aware XML with one real is.netIncome fact.']) }
  if (facts.length !== 1) throw new TaxDeclarationError(['The E-Bilanz artifact must contain exactly one canonical is.netIncome monetary fact.'])
  const lexical = facts[0].trim(); const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/.exec(lexical)
  if (!match) throw new TaxDeclarationError(['The E-Bilanz net-income fact must use a canonical decimal lexical value.'])
  const sign = match[1] === '-' ? BigInt(-1) : BigInt(1); const whole = BigInt(match[2] || '0'); const fraction = (match[3] ?? match[4] ?? '').padEnd(2, '0')
  if (/[^0]/.test(fraction.slice(2))) throw new TaxDeclarationError(['The E-Bilanz net-income fact cannot be represented exactly in cents.'])
  const cents = Number(sign * (whole * BigInt(100) + BigInt(fraction.slice(0, 2))))
  if (!Number.isSafeInteger(cents)) throw new TaxDeclarationError(['The E-Bilanz net-income fact exceeds safe integer cents.'])
  return cents
}

export function validateEBilanzReferences(references: readonly string[], authenticatedPayloadHashes: readonly string[]) {
  const authenticated = new Set(authenticatedPayloadHashes)
  if (references.some(reference => !authenticated.has(reference))) throw new TaxDeclarationError(['Every annual E-Bilanz provenance reference must resolve to a tenant-owned officially valid E-Bilanz payload.'])
}

export function independentAnnualResults(values: readonly AnnualTaxValue[], ledgerResultCents: number) {
  const hgb = values.filter(value => value.field === 'HGB_RESULT')
  const eBilanz = values.filter(value => value.field === 'E_BILANZ_RESULT')
  if (hgb.length !== 1 || !hgb[0].ledgerEntryIds.length && (hgb[0].amountCents !== 0 || ledgerResultCents !== 0) || eBilanz.length !== 1 || eBilanz[0].eBilanzFacts.length !== 1) throw new TaxDeclarationError(['Annual preparation requires exactly one independently sourced HGB_RESULT and E_BILANZ_RESULT with their respective provenance.'])
  return { hgbResultCents: hgb[0].amountCents, ledgerResultCents, eBilanzResultCents: eBilanz[0].amountCents }
}

export function deriveAnnualResultEntryIds(entries: readonly { id: string; state: string; lines: readonly { debitCents: number; creditCents: number; account: { category: string } }[] }[]) {
  return entries.filter(entry => entry.state === 'POSTED' && entry.lines.some(line => (line.debitCents !== 0 || line.creditCents !== 0) && (line.account.category === 'REVENUE' || line.account.category === 'EXPENSE'))).map(entry => entry.id).sort()
}

function sameIdentifiers(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && [...left].sort().every((value, index) => value === right[index])
}
