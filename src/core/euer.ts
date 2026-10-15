import { usesEuer, type CompanyIncomeTaxFacts } from './companyTaxProfile'

export class EuerValidationError extends Error {
  constructor(public readonly issues: string[]) { super(issues.join(' ')) }
}

type Section = 'income' | 'expense' | 'neutral'
type Position = { key: string; section: Section; line2025: number; line2026: number; code: string; label: string }
const position = (key: string, section: Section, line2025: number, code: string, label: string, line2026 = line2025 + 1): Position => ({ key, section, line2025, line2026, code, label })

/** Reviewed BMF form positions; this is not a submission schema or an ERiC dataset. */
export const EUER_POSITIONS = [
  position('smallBusinessReceipts', 'income', 12, '111', 'Betriebseinnahmen als Kleinunternehmer', 12),
  position('taxableReceipts', 'income', 15, '112', 'Umsatzsteuerpflichtige Betriebseinnahmen (netto)', 15),
  position('exemptReceipts', 'income', 16, '103', 'Umsatzsteuerfreie oder nicht steuerbare Betriebseinnahmen', 16),
  position('vatReceived', 'income', 17, '140', 'Vereinnahmte Umsatzsteuer', 17),
  position('vatRefunded', 'income', 18, '141', 'Vom Finanzamt erstattete Umsatzsteuer', 18),
  position('goods', 'expense', 27, '100', 'Waren, Rohstoffe und Hilfsstoffe', 29),
  position('services', 'expense', 29, '110', 'Bezogene Fremdleistungen'),
  position('personnel', 'expense', 30, '120', 'Ausgaben für eigenes Personal'),
  position('rent', 'expense', 39, '150', 'Miete/Pacht für Geschäftsräume'),
  position('telecommunications', 'expense', 43, '280', 'Telekommunikation'),
  position('travel', 'expense', 44, '221', 'Übernachtungs- und Reisenebenkosten'),
  position('training', 'expense', 45, '281', 'Fortbildungskosten'),
  position('advice', 'expense', 46, '194', 'Rechts- und Steuerberatung, Buchführung'),
  position('leasing', 'expense', 47, '222', 'Miete/Leasing für bewegliche Wirtschaftsgüter (ohne Kfz)'),
  position('maintenance', 'expense', 48, '225', 'Instandhaltung (ohne Gebäude und Kfz)'),
  position('insurance', 'expense', 49, '223', 'Beiträge, Gebühren und Versicherungen'),
  position('it', 'expense', 50, '228', 'Laufende EDV-Kosten'),
  position('supplies', 'expense', 51, '229', 'Arbeitsmittel, Bürobedarf und Porto'),
  position('waste', 'expense', 52, '226', 'Abfallbeseitigung'),
  position('transport', 'expense', 53, '227', 'Verpackung und Transport'),
  position('advertising', 'expense', 54, '224', 'Werbekosten'),
  position('inputVatPaid', 'expense', 57, '185', 'Gezahlte abziehbare Vorsteuer'),
  position('vatRemitted', 'expense', 58, '186', 'An das Finanzamt gezahlte Umsatzsteuer'),
  position('otherExpenses', 'expense', 60, '183', 'Übrige unbeschränkt abziehbare Betriebsausgaben'),
  position('withdrawals', 'neutral', 106, '122', 'Geldentnahmen'),
  position('deposits', 'neutral', 107, '123', 'Geldeinlagen'),
] as const

export interface EuerEntry {
  id: string
  paymentDate: string
  position: string
  amountCents: number
  reference: string
  description: string
  recurring?: { dueDate: string; economicYear: number }
}
export interface EuerInput { entries: EuerEntry[]; scopeConfirmed: boolean }
export type EuerProfile = CompanyIncomeTaxFacts & { companyName: string; taxNumber: string; vatRegime: string; activity: string }
export const EUER_SOURCES = {
  2025: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-08-29-anlage-EUER-2025.html',
  2026: 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2026-09-01-anlage-EUER-2026.html',
} as const

export function euerYear(value: unknown): 2025 | 2026 {
  if (value !== 2025 && value !== 2026) throw new EuerValidationError(['EÜR supports calendar years 2025 and 2026.'])
  return value
}
const fail = (message: string): never => { throw new EuerValidationError([message]) }
function date(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail('Payment and due dates must be real YYYY-MM-DD dates.')
  const parsed = new Date(value + 'T00:00:00.000Z')
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return fail('Payment and due dates must be real YYYY-MM-DD dates.')
  return value
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) return fail(`${label} is required (maximum ${max} characters).`)
  return value.trim()
}
export function parseEuerInput(value: unknown): EuerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('An EÜR workpaper is required.')
  const input = value as Partial<EuerInput>
  if (!Array.isArray(input.entries) || input.entries.length > 10000 || typeof input.scopeConfirmed !== 'boolean') return fail('EÜR requires up to 10,000 entries and an explicit scope confirmation.')
  const entries = input.entries.map((raw): EuerEntry => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Every EÜR entry must be an object.')
    const entry = raw as EuerEntry
    if (!EUER_POSITIONS.some(item => item.key === entry.position)) return fail('Select a supported EÜR position.')
    if (!Number.isSafeInteger(entry.amountCents) || entry.amountCents === 0) return fail('Amounts must be nonzero safe integer cents; refunds use negative amounts.')
    let recurring: EuerEntry['recurring']
    if (entry.recurring !== undefined) {
      if (!entry.recurring || typeof entry.recurring !== 'object' || Array.isArray(entry.recurring) || !Number.isInteger(entry.recurring.economicYear) || entry.recurring.economicYear < 2024 || entry.recurring.economicYear > 2027) return fail('Recurring payments require a due date and economic year.')
      recurring = { dueDate: date(entry.recurring.dueDate), economicYear: entry.recurring.economicYear }
      if (['deposits', 'withdrawals'].includes(entry.position)) return fail('Owner transfers cannot use the recurring-payment rule.')
    }
    return { id: text(entry.id, 'Entry ID', 100), paymentDate: date(entry.paymentDate), position: entry.position, amountCents: entry.amountCents, reference: text(entry.reference, 'Source reference', 200), description: text(entry.description, 'Description', 300), ...(recurring ? { recurring } : {}) }
  })
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) return fail('EÜR entry IDs must be unique.')
  return { entries, scopeConfirmed: input.scopeConfirmed }
}

/** Both payment and actual due date must lie within the ten-day boundary window. */
export function euerRecognitionYear(entry: EuerEntry): number {
  const cashYear = Number(entry.paymentDate.slice(0, 4))
  if (!entry.recurring || entry.recurring.economicYear === cashYear) return cashYear
  const economicYear = entry.recurring.economicYear
  if (Math.abs(economicYear - cashYear) !== 1) return fail('Recurring payments may only cross one calendar-year boundary.')
  const boundary = Math.max(cashYear, economicYear)
  const start = `${boundary - 1}-12-22`; const end = `${boundary}-01-10`
  if ([entry.paymentDate, entry.recurring.dueDate].some(value => value < start || value > end)) return fail('The recurring-payment exception requires payment and due date within ten days of the year boundary.')
  return economicYear
}

function sum(values: number[]): number {
  const result = values.reduce((total, value) => total + BigInt(value), BigInt(0))
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) return fail('EÜR totals exceed safe integer cents.')
  return Number(result)
}
export function prepareEuer(yearValue: number, profile: EuerProfile, raw: unknown) {
  const year = euerYear(yearValue); const input = parseEuerInput(raw)
  if (!usesEuer(profile)) return fail('Select and confirm EÜR for the sole trader in the company profile.')
  if (!['STANDARD', 'SMALL_BUSINESS', 'EXEMPT'].includes(profile.vatRegime)) return fail('An authoritative VAT regime is required.')
  for (const entry of input.entries) {
    if (euerRecognitionYear(entry) !== year) return fail(`Entry ${entry.reference} does not belong to EÜR ${year}.`)
    if (entry.position === 'smallBusinessReceipts' && profile.vatRegime !== 'SMALL_BUSINESS') return fail('Small-business receipts require the small-business VAT regime.')
    if (profile.vatRegime === 'SMALL_BUSINESS' && ['taxableReceipts', 'exemptReceipts', 'vatReceived', 'inputVatPaid'].includes(entry.position)) return fail('Small-business receipts and expenses must use gross amounts without separately deducted input VAT.')
    if (profile.vatRegime === 'EXEMPT' && ['taxableReceipts', 'vatReceived', 'inputVatPaid'].includes(entry.position)) return fail('VAT-exempt activities cannot use taxable receipts or deductible input VAT in this workpaper.')
  }
  const positions = EUER_POSITIONS.filter(item => item.key !== 'smallBusinessReceipts' || profile.vatRegime === 'SMALL_BUSINESS').map(item => ({
    ...item, line: year === 2025 ? item.line2025 : item.line2026,
    amountCents: sum(input.entries.filter(entry => entry.position === item.key).map(entry => entry.amountCents)),
    entryIds: input.entries.filter(entry => entry.position === item.key).map(entry => entry.id),
  }))
  const incomeCents = sum(positions.filter(item => item.section === 'income').map(item => item.amountCents))
  const expenseCents = sum(positions.filter(item => item.section === 'expense').map(item => item.amountCents))
  return {
    year, ruleVersion: `EUER-${year}.1`, sourceUrl: EUER_SOURCES[year], input, positions,
    companyName: profile.companyName, taxNumber: profile.taxNumber, activity: profile.activity,
    incomeType: profile.soleTraderTaxProfile!.incomeType, vatRegime: profile.vatRegime,
    incomeCents, expenseCents, profitCents: sum([incomeCents, -expenseCents]),
    incomeLine: 23, expenseLine: year === 2025 ? 75 : 76, profitLine: year === 2025 ? 97 : 98,
    status: input.scopeConfirmed ? 'REVIEWED_WORKPAPER' as const : 'DRAFT' as const,
    transmission: 'MANUAL_ELSTER' as const,
  }
}
export type EuerReport = ReturnType<typeof prepareEuer>

export function euerDecimal(cents: number) {
  const value = BigInt(cents); const absolute = value < BigInt(0) ? -value : value
  return `${value < BigInt(0) ? '-' : ''}${absolute / BigInt(100)},${String(absolute % BigInt(100)).padStart(2, '0')}`
}
export function euerCsv(report: EuerReport): string {
  if (!report.input.scopeConfirmed) return fail('Review and confirm the supported EÜR scope before exporting.')
  const rows = [['EÜR-Arbeitsblatt', String(report.year), report.companyName, report.taxNumber], ['Keine elektronische Übermittlung. In Mein ELSTER prüfen und übertragen.'], ['Zeile', 'Kennzahl', 'Position', 'EUR'],
    ...report.positions.map(item => [String(item.line), item.code, item.label, euerDecimal(item.amountCents)]),
    [String(report.incomeLine), '159', 'Summe Betriebseinnahmen', euerDecimal(report.incomeCents)],
    [String(report.expenseLine), '199', 'Summe Betriebsausgaben', euerDecimal(report.expenseCents)],
    [String(report.profitLine), '219', 'Gewinn/Verlust im bestätigten Umfang', euerDecimal(report.profitCents)],
    [], ['Zahlungsdatum', 'Position', 'Belegreferenz', 'Beschreibung', 'EUR', 'Fälligkeit', 'Wirtschaftliche Zugehörigkeit'],
    ...report.input.entries.map(entry => [entry.paymentDate, entry.position, entry.reference, entry.description, euerDecimal(entry.amountCents), entry.recurring?.dueDate ?? '', String(entry.recurring?.economicYear ?? '')]),
  ]
  const cell = (value: string) => '"' + (/^[\s]*[=+@-]/.test(value) ? "'" + value : value).replaceAll('"', '""') + '"'
  return '\uFEFF' + rows.map(row => row.map(cell).join(';')).join('\r\n') + '\r\n'
}
