export const locales = ['de', 'en'] as const

export type Locale = (typeof locales)[number]

export const defaultLocale: Locale = 'de'
export const localeCookieName = 'NEXT_LOCALE'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && locales.some((locale) => locale === value)
}

export function resolveLocale(value: unknown): Locale {
  return isLocale(value) ? value : defaultLocale
}
