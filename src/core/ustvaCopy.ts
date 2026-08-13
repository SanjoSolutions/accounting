export type UstvaCopyUnit = 'whole-euros' | 'euros-and-cents'

export interface UstvaCopyField {
  key: `KZ${number}`
  code: string
  page: 1 | 2 | 3
  section: string
  label: string
  unit: UstvaCopyUnit
}

export interface UstvaCopyPage { page: 1 | 2 | 3; fields: readonly UstvaCopyField[] }

const fields: readonly UstvaCopyField[] = Object.freeze([
  { key: 'KZ81', code: '81', page: 1, section: 'A', label: 'Steuerpflichtige Umsätze zum Steuersatz von 19 %', unit: 'whole-euros' },
  { key: 'KZ86', code: '86', page: 1, section: 'A', label: 'Steuerpflichtige Umsätze zum Steuersatz von 7 %', unit: 'whole-euros' },
  { key: 'KZ87', code: '87', page: 1, section: 'A', label: 'Steuerpflichtige Umsätze zum Steuersatz von 0 %', unit: 'whole-euros' },
  { key: 'KZ41', code: '41', page: 1, section: 'B', label: 'Innergemeinschaftliche Lieferungen an Abnehmer mit USt-IdNr.', unit: 'whole-euros' },
  { key: 'KZ48', code: '48', page: 2, section: 'B', label: 'Steuerfreie Umsätze ohne Vorsteuerabzug', unit: 'whole-euros' },
  { key: 'KZ89', code: '89', page: 2, section: 'C', label: 'Steuerpflichtige innergemeinschaftliche Erwerbe zum Steuersatz von 19 %', unit: 'whole-euros' },
  { key: 'KZ46', code: '46', page: 2, section: 'D', label: 'Sonstige Leistungen eines im übrigen Gemeinschaftsgebiet ansässigen Unternehmers', unit: 'whole-euros' },
  { key: 'KZ47', code: '47', page: 2, section: 'D', label: 'Steuer zu KZ 46', unit: 'euros-and-cents' },
  { key: 'KZ84', code: '84', page: 2, section: 'D', label: 'Andere Leistungen nach § 13b Absatz 2 Nummer 1, 2, 4 bis 12 UStG', unit: 'whole-euros' },
  { key: 'KZ85', code: '85', page: 2, section: 'D', label: 'Steuer zu KZ 84', unit: 'euros-and-cents' },
  { key: 'KZ60', code: '60', page: 2, section: 'E', label: 'Umsätze des leistenden Unternehmers, für die der Leistungsempfänger die Steuer schuldet', unit: 'whole-euros' },
  { key: 'KZ21', code: '21', page: 2, section: 'E', label: 'Nicht steuerbare sonstige Leistungen gemäß § 18b Satz 1 Nummer 2 UStG', unit: 'whole-euros' },
  { key: 'KZ66', code: '66', page: 2, section: 'F', label: 'Vorsteuerbeträge aus Rechnungen von anderen Unternehmern', unit: 'euros-and-cents' },
  { key: 'KZ61', code: '61', page: 2, section: 'F', label: 'Vorsteuerbeträge aus dem innergemeinschaftlichen Erwerb von Gegenständen', unit: 'euros-and-cents' },
  { key: 'KZ62', code: '62', page: 2, section: 'F', label: 'Entstandene Einfuhrumsatzsteuer', unit: 'euros-and-cents' },
  { key: 'KZ67', code: '67', page: 2, section: 'F', label: 'Vorsteuerbeträge aus Leistungen im Sinne des § 13b UStG', unit: 'euros-and-cents' },
  { key: 'KZ39', code: '39', page: 3, section: 'H', label: 'Abzug der festgesetzten Sondervorauszahlung für Dauerfristverlängerung', unit: 'euros-and-cents' },
  { key: 'KZ83', code: '83', page: 3, section: 'H', label: 'Verbleibende Umsatzsteuer-Vorauszahlung / verbleibender Überschuss', unit: 'euros-and-cents' },
])

export const ustvaCopyPages: readonly UstvaCopyPage[] = Object.freeze([1, 2, 3].map(page => Object.freeze({ page: page as 1 | 2 | 3, fields: Object.freeze(fields.filter(field => field.page === page)) })))

export function formatUstvaCopyValue(amountCents: number, unit: UstvaCopyUnit, locale = 'de-DE') {
  if (!Number.isSafeInteger(amountCents)) throw new Error('UStVA copy values require safe integer cents.')
  const value = unit === 'whole-euros' ? Math.trunc(amountCents / 100) : amountCents / 100
  return new Intl.NumberFormat(locale, { useGrouping: false, minimumFractionDigits: unit === 'whole-euros' ? 0 : 2, maximumFractionDigits: unit === 'whole-euros' ? 0 : 2 }).format(value)
}

export function ustvaPeriodOptions(year: number, frequency: string) {
  if (!Number.isSafeInteger(year) || year < 1000 || year > 9999) throw new Error('UStVA period options require a four-digit year.')
  if (frequency === 'QUARTERLY') return [1, 2, 3, 4].map(quarter => `${year}-Q${quarter}`)
  if (frequency === 'MONTHLY') return Array.from({ length: 12 }, (_, month) => `${year}-${String(month + 1).padStart(2, '0')}`)
  return []
}

export function ustvaCopyFieldValue(values: Readonly<Record<string, number | string | boolean>>, field: UstvaCopyField, locale = 'de-DE') {
  const value = values[field.key]
  return typeof value === 'number' ? formatUstvaCopyValue(value, field.unit, locale) : ''
}
