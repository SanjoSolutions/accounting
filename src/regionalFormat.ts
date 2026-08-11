export const regionalFormats = ['system', 'de-DE', 'en-US'] as const

export type RegionalFormat = (typeof regionalFormats)[number]

export const defaultRegionalFormat: RegionalFormat = 'system'
export const regionalFormatCookieName = 'REGIONAL_FORMAT'

export function isRegionalFormat(value: unknown): value is RegionalFormat {
  return typeof value === 'string' && regionalFormats.some(format => format === value)
}

export function resolveRegionalFormat(value: unknown): RegionalFormat {
  return isRegionalFormat(value) ? value : defaultRegionalFormat
}

function canonicalLocale(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return Intl.getCanonicalLocales(value)[0]
  } catch {
    return undefined
  }
}

/** Uses the first valid Accept-Language tag as the server seed for system format. */
export function resolveServerRegionalLocale(acceptLanguage: string | null | undefined): string {
  const candidate = acceptLanguage?.split(',').map(value => value.split(';')[0]?.trim()).find(Boolean)
  return canonicalLocale(candidate) ?? 'en-US'
}

/** Uses the browser's language preference only after the client is available. */
export function resolveBrowserRegionalLocale(): string {
  if (typeof navigator === 'undefined') return 'en-US'
  const candidates = [...(navigator.languages ?? []), navigator.language]
  for (const candidate of candidates) {
    const locale = canonicalLocale(candidate)
    if (locale) return locale
  }
  return 'en-US'
}

export function regionalLocaleFor(format: RegionalFormat, systemLocale: string): string {
  return format === 'system' ? systemLocale : format
}
