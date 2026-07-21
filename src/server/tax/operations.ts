import 'server-only'

import { createHash } from 'node:crypto'
import { TaxDeclarationError, taxFormRegistry, type DeclarationKind } from '@/core/taxDeclarations'
import { prisma } from '@/server/persistence/client'
import { companyProfileForPeriod } from './profileRepository'
import { secureServiceEndpoint } from './transport'

export type TaxReadinessCheck = {
  id: 'gateway' | 'profile' | 'vat-mappings' | 'form' | 'annual-profile' | 'ledger' | 'e-bilanz' | 'invoice-sequence'
  ready: boolean
  issues: string[]
}

export type TaxReadinessReport = { ready: boolean; ownerId: string; kind: DeclarationKind; period: string; checks: TaxReadinessCheck[] }

export type TaxGatewayEnvironment = Record<string, string | undefined>

export function gatewayOperationalEvent(action: string, outcome: 'success' | 'http-error' | 'timeout' | 'network-error', durationMs: number, httpStatus?: number) {
  return { component: 'official-tax-gateway', action, outcome, durationMs: Math.max(0, Math.round(durationMs)), ...(httpStatus === undefined ? {} : { httpStatus }) }
}

function configuredSecret(value: string | undefined) {
  return typeof value === 'string' && value.trim().length >= 16
}

export function productionGatewayIssues(environment: TaxGatewayEnvironment, formVersion?: string): string[] {
  const issues: string[] = []
  for (const [endpointKey, credentialKey, label] of [
    ['TAX_GATEWAY_URL', 'TAX_GATEWAY_CREDENTIAL', 'official tax gateway'],
    ['ANNUAL_TAX_CALCULATOR_URL', 'ANNUAL_TAX_CALCULATOR_CREDENTIAL', 'annual-tax calculator'],
  ] as const) {
    const endpoint = environment[endpointKey]
    if (!endpoint) issues.push(`Configure the ${label} HTTPS endpoint (${endpointKey}).`)
    else {
      try { secureServiceEndpoint(endpoint, endpointKey, false) }
      catch (error) { issues.push(error instanceof Error ? error.message : `${endpointKey} is invalid.`) }
    }
    if (!configuredSecret(environment[credentialKey])) issues.push(`Configure a non-empty ${label} credential (${credentialKey}) with at least 16 characters.`)
  }
  if (environment.TAX_PRODUCTION_FILING_ENABLED !== 'true') issues.push('TAX_PRODUCTION_FILING_ENABLED must be exactly true.')
  if (!environment.TAX_GATEWAY_QUALIFICATION_ID?.trim()) issues.push('Record the official gateway qualification identifier in TAX_GATEWAY_QUALIFICATION_ID.')
  const qualifiedVersions = new Set((environment.TAX_GATEWAY_QUALIFIED_FORM_VERSIONS ?? '').split(',').map(value => value.trim()).filter(Boolean))
  if (formVersion && !qualifiedVersions.has(formVersion)) issues.push(`Form version ${formVersion} has not been qualified against the official gateway.`)
  return issues
}

export function assertProductionGatewayReady(formVersion: string, environment: TaxGatewayEnvironment = process.env) {
  if (process.env.NODE_ENV !== 'production') return
  const issues = productionGatewayIssues(environment, formVersion)
  if (issues.length) throw new Error(`Production tax submission is disabled: ${issues.join(' ')}`)
}

export function evaluateTaxReadiness(ownerId: string, kind: DeclarationKind, period: string, input: {
  gatewayIssues: string[]
  profileIssues: string[]
  mappingIssues: string[]
  formIssues: string[]
  annualProfileIssues: string[]
  ledgerIssues: string[]
  eBilanzIssues: string[]
  invoiceSequenceIssues: string[]
}): TaxReadinessReport {
  const domains: Array<[TaxReadinessCheck['id'], string[]]> = [
    ['gateway', input.gatewayIssues], ['profile', input.profileIssues], ['vat-mappings', input.mappingIssues],
    ['form', input.formIssues], ['annual-profile', input.annualProfileIssues], ['ledger', input.ledgerIssues],
    ['e-bilanz', input.eBilanzIssues], ['invoice-sequence', input.invoiceSequenceIssues],
  ]
  const checks: TaxReadinessCheck[] = domains.map(([id, issues]) => ({ id, ready: issues.length === 0, issues }))
  return { ready: checks.every(check => check.ready), ownerId, kind, period, checks }
}

export function invoiceSequenceReadinessIssues(
  sequence: { nextValue: number } | null,
  onboarding: { firstUnusedNumber: number; importedCount: number; importedNumbersHash: string; confirmedBy: string } | null,
) {
  const issues: string[] = []
  if (!sequence) return ['Initialize and reconcile the tenant/year invoice-number sequence with the first unused number.']
  if (!onboarding) issues.push('Complete the tenant/year invoice-number import reconciliation; legacy sequence initialization is not production-ready.')
  else {
    if (!Number.isInteger(onboarding.firstUnusedNumber) || onboarding.firstUnusedNumber < 1 || onboarding.firstUnusedNumber > 999_999 || !Number.isInteger(onboarding.importedCount) || onboarding.importedCount < 0 || !/^[a-f0-9]{64}$/.test(onboarding.importedNumbersHash) || !onboarding.confirmedBy.trim()) issues.push('The tenant/year invoice-number onboarding evidence is incomplete or invalid.')
    if (sequence.nextValue < onboarding.firstUnusedNumber) issues.push('The invoice-number sequence contradicts its immutable onboarding reconciliation evidence.')
  }
  if (sequence.nextValue > 999_999) issues.push('The tenant/year invoice-number sequence is exhausted.')
  return issues
}

const annualKinds = new Set<DeclarationKind>(['KST', 'GEWST', 'ZERLEGUNG', 'EST_BUSINESS', 'FESTSTELLUNG'])
const inputVatPosition = 'bs.ass.currAss.receiv.other.vat'
const outputVatPosition = 'bs.eqLiab.liab.other.theroffTax.vat'

export async function getTaxReadiness(ownerId: string, kind: DeclarationKind, period: string): Promise<TaxReadinessReport> {
  const year = Number(period.slice(0, 4))
  const fiscalYear = Number.isInteger(year) ? await prisma.fiscalYear.findFirst({ where: { ownerId, year } }) : null
  let formVersion: string | undefined
  const formIssues: string[] = []
  try { formVersion = taxFormRegistry.resolve(kind, period).version } catch (error) { formIssues.push(error instanceof Error ? error.message : 'The filing form is unsupported.') }
  const gatewayIssues = productionGatewayIssues(process.env, formVersion)
  const profileIssues: string[] = []
  let profile: Awaited<ReturnType<typeof companyProfileForPeriod>> | undefined
  if (!fiscalYear) profileIssues.push('Configure the tenant fiscal year for the requested filing period.')
  else {
    try { profile = await companyProfileForPeriod(ownerId, fiscalYear.startsAt, fiscalYear.endsAt) }
    catch (error) { profileIssues.push(error instanceof Error ? error.message : 'The effective company profile is unavailable.') }
  }
  if (kind === 'USTVA' && profile && (profile.vatRegime !== 'STANDARD' || profile.vatFilingFrequency !== 'MONTHLY')) profileIssues.push('UStVA production readiness requires an effective STANDARD/MONTHLY VAT profile.')

  const mappingIssues: string[] = []
  if (kind === 'USTVA' && profile && fiscalYear) {
    const mappings = await prisma.accountMappingVersion.findMany({ where: { ownerId, chartId: profile.chart, effectiveFrom: { lte: fiscalYear.endsAt } } })
    const effective = mappings.filter(row => row.effectiveFrom <= fiscalYear.startsAt && (!row.effectiveTo || row.effectiveTo >= fiscalYear.endsAt) && row.active)
    if (!effective.some(row => row.eBilanzPosition === inputVatPosition) || !effective.some(row => row.eBilanzPosition === outputVatPosition)) mappingIssues.push('The effective chart must contain active canonical input-VAT and output-VAT control-account mappings for the complete period.')
  }

  const annualProfileIssues: string[] = []
  if (annualKinds.has(kind) && (!profile?.annualTaxProfile || typeof profile.annualTaxProfile.tradeBusiness !== 'boolean' || !Number.isSafeInteger(profile.annualTaxProfile.establishments) || profile.annualTaxProfile.establishments < 1 || typeof profile.annualTaxProfile.adviserExtension !== 'boolean')) annualProfileIssues.push('Configure canonical annual-tax trade-business, establishment and adviser facts.')

  const ledgerIssues: string[] = []
  if (!fiscalYear) ledgerIssues.push('The requested fiscal year does not exist.')
  else {
    const ledgerPeriod = kind === 'USTVA' && /^\d{4}-(?:0[1-9]|1[0-2])$/.test(period) ? {
      bookingDate: {
        gte: new Date(`${period}-01T00:00:00.000Z`),
        lt: new Date(Date.UTC(year, Number(period.slice(5, 7)), 1)),
      },
    } : {}
    if (await prisma.journalEntry.count({ where: { fiscalYearId: fiscalYear.id, state: { not: 'POSTED' }, ...ledgerPeriod } })) ledgerIssues.push(kind === 'USTVA' ? 'Every ledger entry in the filing period must be posted and immutable.' : 'Every ledger entry in the filing year must be posted and immutable.')
  }

  const eBilanzIssues: string[] = []
  if (annualKinds.has(kind)) {
    const evidence = fiscalYear ? await prisma.eBalanceSubmission.findFirst({ where: { ownerId, year, status: 'ACCEPTED' }, orderBy: { createdAt: 'desc' } }) : null
    if (!evidence?.payloadHash || !evidence.requestHash || !evidence.resultXml) eBilanzIssues.push('An authenticated, accepted E-Bilanz receipt with request and payload hashes is required.')
  }

  const [sequence, onboarding] = Number.isInteger(year) ? await Promise.all([
    prisma.invoiceNumberSequence.findUnique({ where: { ownerId_year: { ownerId, year } } }),
    prisma.invoiceNumberSequenceOnboarding.findUnique({ where: { ownerId_year: { ownerId, year } } }),
  ]) : [null, null]
  const invoiceSequenceIssues = invoiceSequenceReadinessIssues(sequence, onboarding)

  return evaluateTaxReadiness(ownerId, kind, period, { gatewayIssues, profileIssues, mappingIssues, formIssues, annualProfileIssues, ledgerIssues, eBilanzIssues, invoiceSequenceIssues })
}

export async function assertTenantTaxReadiness(ownerId: string, kind: DeclarationKind, period: string) {
  if (process.env.NODE_ENV !== 'production') return
  const report = await getTaxReadiness(ownerId, kind, period)
  if (!report.ready) throw new TaxDeclarationError(['Production tax submission is disabled until every readiness check succeeds.', ...report.checks.flatMap(check => check.issues.map(issue => `${check.id}: ${issue}`))])
}

export function importedInvoiceNumbersHash(numbers: readonly string[]) {
  return createHash('sha256').update([...numbers].sort().join('\n')).digest('hex')
}
