import { serializeInlineScriptValue } from './dateFormatting'

export type NumberFormatOptions = Intl.NumberFormatOptions

/** Format a human-facing number with an explicit regional locale. */
export function formatNumber(value: number, locale: string, options: NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(locale, { useGrouping: true, ...options }).format(value)
}

/** Format an integer count while preserving the numeric value for plural selection. */
export function formatCount(value: number, locale: string): string {
  return formatNumber(value, locale, { maximumFractionDigits: 0 })
}

/** Format currency represented in minor units (for example, cents). */
export function formatCurrencyFromCents(cents: number, currency: string, locale: string): string {
  return formatCurrencyFromUnits(cents / 100, currency, locale)
}

/** Format currency represented in major units with an explicit ISO 4217 code. */
export function formatCurrencyFromUnits(value: number, currency: string, locale: string): string {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('An uppercase ISO 4217 currency code is required.')
  return formatNumber(value, locale, { style: 'currency', currency })
}

/** Format a fraction such as 0.19 as 19%. */
export function formatPercentFraction(value: number, locale: string, options: NumberFormatOptions = {}): string {
  return formatNumber(value, locale, { style: 'percent', ...options })
}

/** Format percentage points such as 19 as 19%. */
export function formatPercentUnits(value: number, locale: string, options: NumberFormatOptions = {}): string {
  return formatPercentFraction(value / 100, locale, options)
}

/** Format basis points such as 1900 as 19%. */
export function formatPercentBasisPoints(value: number, locale: string, options: NumberFormatOptions = {}): string {
  return formatPercentFraction(value / 10_000, locale, options)
}

/** Build the pre-paint browser correction used by LocalNumber. */
export function inlineNumberScript(
  id: string,
  value: number,
  options: NumberFormatOptions,
  preference: 'system' | 'de-DE' | 'en-US',
) {
  const idJson = serializeInlineScriptValue(id)
  const valueJson = serializeInlineScriptValue(value)
  const optionsJson = serializeInlineScriptValue(options)
  const locale = preference === 'system'
    ? `(navigator.languages&&navigator.languages.length?navigator.languages[0]:navigator.language)||'en-US'`
    : serializeInlineScriptValue(preference)
  return `(function(){var n=document.getElementById(${idJson});if(!n)return;n.textContent=new Intl.NumberFormat(${locale},${optionsJson}).format(${valueJson})})()`
}
