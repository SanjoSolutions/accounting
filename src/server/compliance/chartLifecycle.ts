import type { FiscalPeriod } from './fiscalPeriods'

export type AccountType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE'
export interface AccountMapping { accountNumber: number; name: string; accountType: AccountType; normalBalance: 'DEBIT' | 'CREDIT'; hgbPosition: string; eBilanzPosition: string; vatCode?: string; active?: boolean }
export interface MappingVersion { id: string; ownerId: string; chartId: string; effectiveFrom: string; effectiveTo?: string; mappings: AccountMapping[] }
const accountTypes: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE']

const mapping = (accountNumber: number, name: string, accountType: AccountType, eBilanzPosition: string, vatCode?: string): AccountMapping => ({ accountNumber, name, accountType, normalBalance: ['ASSET', 'EXPENSE'].includes(accountType) ? 'DEBIT' : 'CREDIT', hgbPosition: accountType === 'REVENUE' ? 'HGB.275.2.1' : accountType === 'EXPENSE' ? 'HGB.275.2.8' : 'HGB.266', eBilanzPosition, ...(vatCode ? { vatCode } : {}) })
export const STANDARD_CHARTS = {
  SKR03: [
    mapping(1000, 'Kasse', 'ASSET', 'bs.ass.currAss.cashEquiv.cash'), mapping(1200, 'Bank', 'ASSET', 'bs.ass.currAss.cashEquiv.bank'),
    mapping(1400, 'Forderungen aus Lieferungen und Leistungen', 'ASSET', 'bs.ass.currAss.receiv.trade'), mapping(1576, 'Abziehbare Vorsteuer 19 %', 'ASSET', 'bs.ass.currAss.receiv.other.vat', 'V19'),
    mapping(1600, 'Verbindlichkeiten aus Lieferungen und Leistungen', 'LIABILITY', 'bs.eqLiab.liab.trade'), mapping(1776, 'Umsatzsteuer 19 %', 'LIABILITY', 'bs.eqLiab.liab.other.theroffTax.vat', 'U19'),
    mapping(2900, 'Eigenkapital', 'EQUITY', 'bs.eqLiab.equity'), mapping(4930, 'Bürobedarf', 'EXPENSE', 'is.netIncome.regular.operatingTC.otherCost'),
    mapping(8400, 'Erlöse 19 % USt', 'REVENUE', 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput', 'U19'),
  ],
  SKR04: [
    mapping(1600, 'Kasse', 'ASSET', 'bs.ass.currAss.cashEquiv.cash'), mapping(1800, 'Bank', 'ASSET', 'bs.ass.currAss.cashEquiv.bank'),
    mapping(1200, 'Forderungen aus Lieferungen und Leistungen', 'ASSET', 'bs.ass.currAss.receiv.trade'), mapping(1406, 'Abziehbare Vorsteuer 19 %', 'ASSET', 'bs.ass.currAss.receiv.other.vat', 'V19'),
    mapping(3300, 'Verbindlichkeiten aus Lieferungen und Leistungen', 'LIABILITY', 'bs.eqLiab.liab.trade'), mapping(3806, 'Umsatzsteuer 19 %', 'LIABILITY', 'bs.eqLiab.liab.other.theroffTax.vat', 'U19'),
    mapping(4400, 'Erlöse 19 % USt', 'REVENUE', 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput', 'U19'),
  ],
} as const

export function seedChart(chartId: string, imported?: AccountMapping[]): AccountMapping[] {
  if (chartId === 'SKR03' || chartId === 'SKR04') return STANDARD_CHARTS[chartId].map(item => ({ ...item }))
  if (!chartId.startsWith('CUSTOM:') || !imported?.length) throw new Error('Custom/imported charts must contain at least one account')
  return imported.map(item => ({ ...item }))
}

export function validateImportedChart(input: unknown): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['Imported chart must be an object']
  const chart = input as { id?: unknown; mappings?: unknown }
  const issues: string[] = []
  if (typeof chart.id !== 'string' || !/^CUSTOM:.+/.test(chart.id)) issues.push('Imported chart id must use CUSTOM:*')
  if (!Array.isArray(chart.mappings) || !chart.mappings.length) return [...issues, 'Imported chart requires at least one mapping']
  const numbers = new Set<number>()
  chart.mappings.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) { issues.push(`Mapping ${index} must be an object`); return }
    const item = candidate as Partial<AccountMapping>
    if (!Number.isInteger(item.accountNumber) || (item.accountNumber ?? 0) <= 0 || (item.accountNumber ?? 0) > 2_147_483_647) issues.push(`Mapping ${index} accountNumber is invalid`)
    else if (numbers.has(item.accountNumber!)) issues.push(`Mapping ${index} accountNumber is duplicated`)
    else numbers.add(item.accountNumber!)
    for (const field of ['name', 'hgbPosition', 'eBilanzPosition'] as const) if (typeof item[field] !== 'string' || !item[field]!.trim()) issues.push(`Mapping ${index} ${field} is required`)
    if (!accountTypes.includes(item.accountType as AccountType)) issues.push(`Mapping ${index} accountType is invalid`)
    if (!['DEBIT', 'CREDIT'].includes(item.normalBalance ?? '')) issues.push(`Mapping ${index} normalBalance is invalid`)
    if (item.vatCode !== undefined && (typeof item.vatCode !== 'string' || !item.vatCode.trim())) issues.push(`Mapping ${index} vatCode is invalid`)
    if (item.active !== undefined && typeof item.active !== 'boolean') issues.push(`Mapping ${index} active is invalid`)
  })
  if (!issues.length && !(chart.mappings as AccountMapping[]).some(item => item.active !== false)) issues.push('Imported chart requires at least one active mapping')
  if (!issues.length) issues.push(...validateMappings(chart.mappings as AccountMapping[]))
  return issues
}
export function validateChartSwitch(hasPostedEntries: boolean, currentChart: string | undefined, nextChart: string): string[] {
  return hasPostedEntries && currentChart !== undefined && currentChart !== nextChart ? ['Chart cannot be switched after journal entries have been posted'] : []
}
export function scaleMappingsForAccountLength(mappings: AccountMapping[], accountLength: number | null | undefined): AccountMapping[] {
  const length = accountLength ?? 4
  if (!Number.isInteger(length) || length < 4 || length > 8) throw new Error('Account length must be an integer from 4 to 8')
  const scale = 10 ** (length - 4)
  return mappings.map(mapping => ({ ...mapping, accountNumber: mapping.accountNumber * scale }))
}
export function validateActiveChartRevision(hasPostedEntries: boolean, revisesActiveChart: boolean): string[] { return hasPostedEntries && revisesActiveChart ? ['Active chart mappings cannot be revised after journal entries have been posted'] : [] }
export function validateActiveRevisionEffectiveDate(revisesActiveChart: boolean, effectiveFrom: string, today: string): string[] { return revisesActiveChart && effectiveFrom !== today ? ['Active chart revisions must use today; historical and future cohorts require a scheduled version workflow'] : [] }
export function resolveTargetChart(requestedChart: string | undefined, profileChanging: boolean, currentLedgerChart: string | undefined, cachedChart: string) { return requestedChart !== undefined || profileChanging ? requestedChart ?? cachedChart : currentLedgerChart ?? cachedChart }
export function shouldGuardActiveRevision(importedChartIsActive: boolean, cohortWasCreated: boolean) { return importedChartIsActive && cohortWasCreated }
export function isIdempotentMappingRetry(existing: AccountMapping, candidate: AccountMapping) {
  return existing.accountNumber === candidate.accountNumber && existing.name === candidate.name && existing.accountType === candidate.accountType && existing.normalBalance === candidate.normalBalance && existing.hgbPosition === candidate.hgbPosition && existing.eBilanzPosition === candidate.eBilanzPosition && (existing.vatCode ?? undefined) === (candidate.vatCode ?? undefined) && (existing.active !== false) === (candidate.active !== false)
}
export function isIdempotentMappingCohort(existing: AccountMapping[], candidate: AccountMapping[]) {
  if (existing.length !== candidate.length) return false
  const orderedExisting = [...existing].sort((a, b) => a.accountNumber - b.accountNumber)
  const orderedCandidate = [...candidate].sort((a, b) => a.accountNumber - b.accountNumber)
  return orderedExisting.every((mapping, index) => isIdempotentMappingRetry(mapping, orderedCandidate[index]))
}
export function selectCoherentMappingVersion(versions: MappingVersion[], ownerId: string, chartId: string, date: string): MappingVersion | undefined {
  return versions.filter(version => version.ownerId === ownerId && version.chartId === chartId && version.effectiveFrom <= date && (!version.effectiveTo || version.effectiveTo >= date)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
}

export function mappingsForPeriod(versions: MappingVersion[], ownerId: string, chartId: string, period: FiscalPeriod): MappingVersion {
  const match = versions.filter(version => version.ownerId === ownerId && version.chartId === chartId && version.effectiveFrom <= period.startsAt && (!version.effectiveTo || version.effectiveTo >= period.endsAt)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
  if (!match) throw new Error('No mapping version covers the fiscal period')
  const midPeriodSuccessor = versions.find(version => version.ownerId === ownerId && version.chartId === chartId && version.effectiveFrom > match.effectiveFrom && version.effectiveFrom <= period.endsAt)
  if (midPeriodSuccessor) throw new Error('Mapping cohort changes inside the fiscal period')
  return match
}

export function validateMappings(mappings: AccountMapping[], accountNumbers?: number[]): string[] {
  const issues: string[] = []
  const required = accountNumbers ?? mappings.filter(item => item.active !== false).map(item => item.accountNumber)
  for (const number of required) {
    const mapping = mappings.find(item => item.accountNumber === number && item.active !== false)
    if (!mapping) { issues.push(`${number}: missing mapping`); continue }
    if (!mapping.name || !mapping.hgbPosition || !mapping.eBilanzPosition) issues.push(`${number}: incomplete reporting mapping`)
    const expected = ['ASSET', 'EXPENSE'].includes(mapping.accountType) ? 'DEBIT' : 'CREDIT'
    if (mapping.normalBalance !== expected) issues.push(`${number}: normal balance incompatible with account type`)
  }
  return issues
}

export function reproduceHistoricAccount(versions: MappingVersion[], ownerId: string, chartId: string, accountNumber: number, date: string): AccountMapping | undefined {
  return versions.filter(version => version.ownerId === ownerId && version.chartId === chartId && version.effectiveFrom <= date && (!version.effectiveTo || version.effectiveTo >= date)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]?.mappings.find(item => item.accountNumber === accountNumber)
}

export function mappingAuditExport(versions: MappingVersion[]) { return versions.map(version => ({ ...version, mappings: version.mappings.map(mapping => ({ ...mapping })) })) }
