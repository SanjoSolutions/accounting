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

const OTHER_EU_COUNTRIES = new Set(['AT', 'BE', 'BG', 'CY', 'CZ', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'])
const EU_VAT_ID_PATTERNS: Readonly<Record<string, RegExp>> = {
  AT: /^ATU\d{8}$/, BE: /^BE0?\d{9}$/, BG: /^BG\d{9,10}$/, CY: /^CY\d{8}[A-Z]$/, CZ: /^CZ\d{8,10}$/, DK: /^DK\d{8}$/, EE: /^EE\d{9}$/,
  ES: /^ES[A-Z0-9]\d{7}[A-Z0-9]$/, FI: /^FI\d{8}$/, FR: /^FR[A-Z0-9]{2}\d{9}$/, GR: /^EL\d{9}$/, HR: /^HR\d{11}$/, HU: /^HU\d{8}$/, IE: /^IE[A-Z0-9]{8,9}$/,
  IT: /^IT\d{11}$/, LT: /^LT(?:\d{9}|\d{12})$/, LU: /^LU\d{8}$/, LV: /^LV\d{11}$/, MT: /^MT\d{8}$/, NL: /^NL[A-Z0-9]{9}B\d{2}$/, PL: /^PL\d{10}$/,
  PT: /^PT\d{9}$/, RO: /^RO\d{2,10}$/, SE: /^SE\d{12}$/, SI: /^SI\d{8}$/, SK: /^SK\d{10}$/,
}

export type IncomingReverseChargeTreatment =
  | NonNullable<ReturnType<typeof classifyDomesticGermanReverseCharge>>
  | { kind: 'DE_13B_EU_SERVICE'; supportedAssessmentRatesBasisPoints: readonly [1900]; reason: 'UStG §3a(2), §13b(1); VAT Directive Article 196' }

/** Classifies only the two supported recipient-liability profiles and rejects ambiguous AE evidence. */
export function classifyIncomingGermanReverseCharge(data: StructuredInvoiceData): IncomingReverseChargeTreatment | null {
  const hasAe = data.reverseCharge || data.lines.some(line => line.taxCategoryCode === 'AE' || line.reverseCharge)
  if (!hasAe) return null
  if (data.seller.countryCode === 'DE') return classifyDomesticGermanReverseCharge(data)
  return classifyEuSupplierServiceReverseCharge(data)
}

export function classifyEuSupplierServiceReverseCharge(data: StructuredInvoiceData): IncomingReverseChargeTreatment {
  const sellerCountry = data.seller.countryCode.toUpperCase()
  if (!OTHER_EU_COUNTRIES.has(sellerCountry)) throw new TypeError('EU-service §13b supports only a supplier established in another current EU member country, excluding Germany and third countries.')
  if (data.buyer.countryCode !== 'DE' || !/^DE\d{9}$/.test(normalizeVatId(data.buyer.vatId))) throw new TypeError('EU-service §13b requires a German business buyer with a German VAT ID.')
  if (!EU_VAT_ID_PATTERNS[sellerCountry]?.test(normalizeVatId(data.seller.vatId))) throw new TypeError('EU-service §13b requires a syntactically valid supplier VAT ID matching the other EU member country.')
  if (!data.reverseCharge || !data.lines.length || data.lines.some(line => line.taxCategoryCode !== 'AE' || !line.reverseCharge || line.taxRateBasisPoints !== 0 || !isEuServiceReverseChargeReason(line.exemptionReason))) {
    throw new TypeError('EU-service §13b requires every line to use EN16931 category AE, zero supplier VAT, and an explicit §13b(1) or Article 196 reverse-charge reason.')
  }
  if (data.taxAmountCents !== 0 || data.grossAmountCents !== data.netAmountCents || (data.payableAmountCents ?? data.grossAmountCents) !== data.netAmountCents) throw new TypeError('An EU-service §13b supplier invoice must have supplier VAT of zero and payable gross equal to net.')
  return { kind: 'DE_13B_EU_SERVICE', supportedAssessmentRatesBasisPoints: [1900], reason: 'UStG §3a(2), §13b(1); VAT Directive Article 196' }
}

export function requireIncomingReverseChargeRate(classification: IncomingReverseChargeTreatment | null, selected: unknown) {
  if (!classification) return null
  if (selected !== 1900) throw new TypeError(`Confirm the supported 19% ${classification.kind === 'DE_13B_EU_SERVICE' ? 'EU-service ' : 'domestic '}§13b assessment rate explicitly before posting.`)
  return 1900 as const
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

function isEuServiceReverseChargeReason(value: string | undefined) {
  const normalized = value?.normalize('NFKC').replaceAll(/\s+/g, ' ').trim() ?? ''
  const legalBasis = /(?:§\s*)?13b\s*(?:(?:Abs(?:atz)?\.?)\s*1|\(\s*1\s*\))/i.test(normalized) || /Art(?:icle|ikel)?\.?\s*196\b/i.test(normalized)
  return legalBasis && /reverse[ -]?charge|Steuerschuldnerschaft\s+des\s+Leistungsempf[aä]ngers/i.test(normalized)
}

function normalizeVatId(value: string | undefined) { return value?.normalize('NFKC').replaceAll(/[^A-Za-z0-9]/g, '').toUpperCase() ?? '' }
