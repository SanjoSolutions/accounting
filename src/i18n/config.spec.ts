import { describe, expect, it } from 'vitest'
import de from '../../messages/de.json'
import en from '../../messages/en.json'
import { defaultLocale, isLocale, locales, resolveLocale } from './config'

function messageKeys(value: object, prefix = ''): string[] {
  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof nestedValue === 'object' && nestedValue !== null
      ? messageKeys(nestedValue, path)
      : [path]
  })
}

describe('locale configuration', () => {
  it('supports German and English with German as the default', () => {
    expect(locales).toEqual(['de', 'en'])
    expect(defaultLocale).toBe('de')
    expect(resolveLocale(undefined)).toBe('de')
    expect(resolveLocale('invalid')).toBe('de')
    expect(resolveLocale('en')).toBe('en')
  })

  it('only accepts configured locales', () => {
    expect(isLocale('de')).toBe(true)
    expect(isLocale('en')).toBe(true)
    expect(isLocale('fr')).toBe(false)
  })

})

describe('translation messages', () => {
  it('provides the same complete message set in German and English', () => {
    expect(messageKeys(de).sort()).toEqual(messageKeys(en).sort())
  })

  it('uses German as the base wording and provides English translations', () => {
    expect(de.Navbar.Accounting).toBe('Buchführung')
    expect(en.Navbar.Accounting).toBe('Accounting')
    expect(de.Navbar.ExportImport).toBe('Export / Import')
    expect(en.Navbar.ExportImport).toBe('Export / Import')
    expect(de.LanguageSelect.label).toBe('Sprache auswählen')
    expect(en.LanguageSelect.label).toBe('Select language')
  })
})
