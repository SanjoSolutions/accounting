import type { StructuredInvoiceData } from './eInvoice'

export const DE_13B_INPUT_VAT_CODE = 'DE_13B_INPUT_19'
export const DE_13B_OUTPUT_VAT_CODE = 'DE_13B_OUTPUT_19'

export type IncomingReverseChargeAccounts = {
  chart: 'SKR03' | 'SKR04'
  rateBasisPoints: 1900
  inputVatAccountNumber: number
  outputVatAccountNumber: number
}

export function parseIncomingReverseChargeAccounts(value: unknown): IncomingReverseChargeAccounts | null {
  if (value === undefined || value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Incoming §13b account configuration must be an object.')
  const record = value as Record<string, unknown>
  if (!['SKR03', 'SKR04'].includes(String(record.chart)) || record.rateBasisPoints !== 1900
    || !Number.isSafeInteger(record.inputVatAccountNumber) || Number(record.inputVatAccountNumber) <= 0
    || !Number.isSafeInteger(record.outputVatAccountNumber) || Number(record.outputVatAccountNumber) <= 0
    || record.inputVatAccountNumber === record.outputVatAccountNumber
    || Object.keys(record).sort().join(',') !== 'chart,inputVatAccountNumber,outputVatAccountNumber,rateBasisPoints') {
    throw new TypeError('Incoming §13b configuration requires one chart-bound 19% input account and a different output account.')
  }
  return { chart: record.chart as 'SKR03' | 'SKR04', rateBasisPoints: 1900, inputVatAccountNumber: Number(record.inputVatAccountNumber), outputVatAccountNumber: Number(record.outputVatAccountNumber) }
}

export function requireIncomingReverseChargeAccountsForLedger(configuration: IncomingReverseChargeAccounts, chart: string, accountLength = 4) {
  if (configuration.chart !== chart) throw new TypeError('Incoming §13b control accounts must be configured for the active ledger chart.')
  if (!Number.isSafeInteger(accountLength) || accountLength < 4 || accountLength > 8) throw new TypeError('The active ledger account length is unsupported for §13b controls.')
  const minimum = 10 ** (accountLength - 1)
  const maximum = 10 ** accountLength - 1
  if ([configuration.inputVatAccountNumber, configuration.outputVatAccountNumber].some(number => number < minimum || number > maximum)) throw new TypeError(`Incoming §13b control accounts must use exactly ${accountLength} digits for the active ledger.`)
  return configuration
}

export function classifyDomesticGermanReverseCharge(data: StructuredInvoiceData) {
  const hasAe = data.lines.some(line => line.taxCategoryCode === 'AE' || line.reverseCharge)
  if (!hasAe && !data.reverseCharge) return null
  if (data.seller.countryCode !== 'DE' || data.buyer.countryCode !== 'DE') throw new TypeError('This §13b profile supports only domestic German supplier and recipient parties.')
  if (!data.reverseCharge || !data.lines.length || data.lines.some(line => line.taxCategoryCode !== 'AE' || !line.reverseCharge || line.taxRateBasisPoints !== 0 || !isSection13bReason(line.exemptionReason))) {
    throw new TypeError('Domestic §13b requires every line to use EN16931 category AE, zero supplier VAT, and an explicit §13b UStG reason.')
  }
  if (data.taxAmountCents !== 0 || data.grossAmountCents !== data.netAmountCents || (data.payableAmountCents ?? data.grossAmountCents) !== data.netAmountCents) throw new TypeError('A domestic §13b supplier invoice must have supplier VAT of zero and payable gross equal to net.')
  return { kind: 'DE_13B_DOMESTIC' as const, supportedAssessmentRatesBasisPoints: [1900] as const, reason: 'UStG §13b recipient' }
}

export function requireDomesticReverseChargeRate(classification: ReturnType<typeof classifyDomesticGermanReverseCharge>, selected: unknown) {
  if (!classification) return null
  if (selected !== 1900) throw new TypeError('Confirm the supported 19% domestic §13b assessment rate explicitly before posting.')
  return 1900 as const
}

function isSection13bReason(value: string | undefined) {
  const normalized = value?.normalize('NFKC').replaceAll(/\s+/g, ' ').trim() ?? ''
  return /(?:§\s*)?13b\b.*UStG|UStG.*(?:§\s*)?13b\b/i.test(normalized)
}
