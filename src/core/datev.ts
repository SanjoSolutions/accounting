import { AccountingValidationError, MAX_DATABASE_CENTS, type AccountCategory } from './doubleEntry'
import { parse } from 'csv-parse/sync'

export type DatevFile = { name: string; bytes: Uint8Array }

export type DatevAccount = {
  number: number
  name: string
  category: AccountCategory
}

export type DatevBooking = {
  bookingDate: string
  amountCents: number
  side: 'S' | 'H'
  accountNumber: number
  contraAccountNumber: number
  documentNumber: string
  description: string
  taxCode?: string
  automaticTax?: { kind: 'INPUT' | 'OUTPUT'; rate: 7 | 19; accountNumber: number; splitSide: 'ACCOUNT' | 'CONTRA' }
  reverseCharge?: { rate: 19; inputTaxAccountNumber: number; outputTaxAccountNumber: number; baseSide: 'ACCOUNT' | 'CONTRA' }
  generalReversal?: boolean
  identity: string | null
}

export type DatevImport = {
  accounts: DatevAccount[]
  bookings: DatevBooking[]
  chart: DatevChart
  consultantNumber: string
  clientNumber: string
  accountLength: number
  masterAccountNumbers: number[]
}

type DatevTable = { metadata: string[]; headers: string[]; rows: string[][]; name: string }
export type DatevChart = 'SKR03' | 'SKR04'
const MAX_IMPORT_RECORDS = 1_500
const MAX_BOOKING_TEXT_LENGTH = 60
const MAX_DOCUMENT_REFERENCE_LENGTH = 40
const MAX_MASTER_NAME_LENGTH = 255
const SUPPORTED_TAX_START = '2021-01-01'
const SUPPORTED_TAX_END = '2026-12-31'

export function parseDatevFiles(files: DatevFile[]): DatevImport {
  if (files.length === 0) throw new AccountingValidationError(['Mindestens eine DATEV-CSV-Datei ist erforderlich.'])
  const tables: DatevTable[] = []
  let remainingRecords = MAX_IMPORT_RECORDS
  for (const file of files) {
    const table = parseDatevFile(file, remainingRecords)
    if (table) {
      remainingRecords = consumeDatevRecordBudget(remainingRecords, table.rows.length + 2)
      tables.push(table)
    }
  }
  const clientKeys = new Set(tables.map(table => {
    const consultant = table.metadata[10]?.trim()
    const client = table.metadata[11]?.trim()
    if (!consultant || !client) throw new AccountingValidationError([`${table.name}: Berater- und Mandantennummer sind erforderlich.`])
    return `${consultant}:${client}`
  }))
  if (clientKeys.size > 1) throw new AccountingValidationError(['Die DATEV-Dateien gehören zu unterschiedlichen Beratern oder Mandanten.'])
  const bookingTables = tables.filter(table => table.metadata[3] === 'Buchungsstapel')
  if (bookingTables.length === 0) throw new AccountingValidationError(['Der Upload enthält keinen DATEV-Buchungsstapel.'])
  const charts = new Set(bookingTables.map(table => detectDatevChart(table, parseAccountLength(table))))
  if (charts.size !== 1) throw new AccountingValidationError(['Die DATEV-Dateien verwenden unterschiedliche Sachkontenrahmen.'])
  const chart = [...charts][0]
  const accountLength = parseAccountLength(bookingTables[0])
  const consultantNumber = bookingTables[0].metadata[10].trim()
  const clientNumber = bookingTables[0].metadata[11].trim()
  const masterNames = new Map<number, string>()
  for (const table of tables.filter(table => table.metadata[3] === 'Debitoren/Kreditoren')) {
    if (parseAccountLength(table) !== accountLength) throw new AccountingValidationError(['Die DATEV-Stammdaten verwenden eine andere Sachkontenlänge als die Buchungsdaten.'])
    for (const row of table.rows) {
      const number = parseAccount(value(table, row, 'Konto'), table.name, accountLength)
      if (number < 10 ** accountLength) throw new AccountingValidationError([`${table.name}: Debitoren/Kreditoren müssen Personenkonten sein.`])
      const rawName = firstPresent(table, row, [
        'Name (Adressattyp Unternehmen)', 'Name (Adressattyp natürl. Person)',
        'Name (Adressattyp keine Angabe)', 'Kurzbezeichnung',
      ])
      const name = validateDatevText(rawName, MAX_MASTER_NAME_LENGTH, table.name, 'Kontoname')
      if (name) masterNames.set(number, name)
    }
  }
  const accounts = new Map<number, DatevAccount>()
  for (const [number, name] of masterNames) accounts.set(number, { number, name, category: inferDatevAccountCategory(number, chart, accountLength) })
  const bookings: DatevBooking[] = []
  for (const table of bookingTables) {
    if (parseAccountLength(table) !== accountLength) throw new AccountingValidationError(['Die DATEV-Dateien verwenden unterschiedliche Sachkontenlängen.'])
    const fiscalYearStart = parseMetadataDate(table.metadata[12], table.name, 'Wirtschaftsjahresbeginn')
    const periodStart = parseMetadataDate(table.metadata[14], table.name, 'Periodenbeginn')
    const periodEnd = parseMetadataDate(table.metadata[15], table.name, 'Periodenende')
    const year = Number(fiscalYearStart.slice(0, 4))
    const baseCurrency = table.metadata[21]?.trim() || 'EUR'
    if (baseCurrency !== 'EUR') throw new AccountingValidationError([`${table.name}: Als Basiswährung wird derzeit nur EUR unterstützt.`])
    if (fiscalYearStart.slice(4) !== '0101') {
      throw new AccountingValidationError([`${table.name}: Abweichende Wirtschaftsjahre werden noch nicht unterstützt.`])
    }
    if (periodStart > periodEnd || periodStart.slice(0, 4) !== String(year) || periodEnd.slice(0, 4) !== String(year)) {
      throw new AccountingValidationError([`${table.name}: Der Buchungszeitraum liegt nicht vollständig im Wirtschaftsjahr.`])
    }
    table.rows.forEach((row, rowIndex) => {
      const accountNumber = parseAccount(value(table, row, 'Konto'), table.name, accountLength)
      const contraAccountNumber = parseAccount(value(table, row, 'Gegenkonto (ohne BU-Schlüssel)'), table.name, accountLength)
      for (const number of [accountNumber, contraAccountNumber]) {
        if (!accounts.has(number)) accounts.set(number, { number, name: `DATEV-Konto ${number}`, category: inferDatevAccountCategory(number, chart, accountLength) })
      }
      const side = value(table, row, 'Soll/Haben-Kennzeichen').toUpperCase()
      if (side !== 'S' && side !== 'H') throw new AccountingValidationError([`${table.name}, Zeile ${rowIndex + 3}: Soll/Haben-Kennzeichen muss S oder H sein.`])
      const generalReversal = optionalValue(table, row, 'Generalumkehr (GU)')?.trim() || ''
      if (generalReversal !== '' && generalReversal !== '0' && generalReversal !== '1') throw new AccountingValidationError([`${table.name}, Zeile ${rowIndex + 3}: Generalumkehr muss leer, 0 oder 1 sein.`])
      if (optionalValue(table, row, 'Skonto')?.trim()) throw new AccountingValidationError([`${table.name}, Zeile ${rowIndex + 3}: Buchungen mit Skonto werden noch nicht unterstützt.`])
      const sourceDocument = validateDatevText(value(table, row, 'Belegfeld 1').trim(), MAX_DOCUMENT_REFERENCE_LENGTH, table.name, 'Belegfeld 1', rowIndex + 3)
      const guid = optionalValue(table, row, 'Buchungs GUID')?.trim()
      const bookingDate = parseBookingDate(value(table, row, 'Belegdatum'), year, table.name, rowIndex + 3)
      const compactBookingDate = bookingDate.replaceAll('-', '')
      if (compactBookingDate < periodStart || compactBookingDate > periodEnd) throw new AccountingValidationError([`${table.name}, Zeile ${rowIndex + 3}: Das Belegdatum liegt außerhalb des angegebenen Buchungszeitraums.`])
      if (optionalValue(table, row, 'Leistungsdatum')?.trim()) throw new AccountingValidationError([`${table.name}, Zeile ${rowIndex + 3}: Buchungen mit Leistungsdatum werden noch nicht unterstützt.`])
      const hasAdvancePaymentSemantics = table.headers.some((header, index) =>
        (header === 'Buchungstyp' || header.includes('(Anzahlungen)')) && Boolean(row[index]?.trim()),
      )
      if (hasAdvancePaymentSemantics) throw new AccountingValidationError([`${table.name}, Zeile ${rowIndex + 3}: Anzahlungsbuchungen werden noch nicht unterstützt.`])
      const rowCurrency = optionalValue(table, row, 'WKZ Umsatz')?.trim() || baseCurrency
      const baseAmount = optionalValue(table, row, 'Basis-Umsatz')?.trim()
      const rowBaseCurrency = optionalValue(table, row, 'WKZ Basis-Umsatz')?.trim()
      if (rowCurrency !== baseCurrency && (!baseAmount || rowBaseCurrency !== baseCurrency)) {
        throw new AccountingValidationError([`${table.name}, Zeile ${rowIndex + 3}: Fremdwährungsbuchungen benötigen einen EUR-Basisumsatz.`])
      }
      const amountCents = parseDatevAmount(rowCurrency === baseCurrency ? value(table, row, 'Umsatz (ohne Soll/Haben-Kz)') : baseAmount!, table.name, rowIndex + 3)
      const bookingText = validateDatevText(value(table, row, 'Buchungstext').trim(), MAX_BOOKING_TEXT_LENGTH, table.name, 'Buchungstext', rowIndex + 3)
      const description = bookingText || `DATEV-Import${sourceDocument ? ` ${sourceDocument}` : ''}`
      const taxCode = normalizeDatevTaxCode(optionalValue(table, row, 'BU-Schlüssel')?.trim() || '', table.name, rowIndex + 3)
      const accountAutomatic = !taxCode ? automaticAccountTax(accountNumber, contraAccountNumber, chart, accountLength) : undefined
      const taxDefinition = taxCode && taxCode !== '1' ? parseAutomaticTax(taxCode, chart, accountLength, table.name, rowIndex + 3) : accountAutomatic?.automaticTax
      const automaticTax = taxDefinition ? {
        ...taxDefinition,
        splitSide: determineAutomaticTaxSide(taxDefinition.kind, accounts.get(accountNumber)!, accounts.get(contraAccountNumber)!, accountLength, table.name, rowIndex + 3),
      } : undefined
      if (automaticTax && !accounts.has(automaticTax.accountNumber)) accounts.set(automaticTax.accountNumber, {
        number: automaticTax.accountNumber,
        name: automaticTax.kind === 'INPUT' ? `DATEV Vorsteuer ${automaticTax.rate} %` : `DATEV Umsatzsteuer ${automaticTax.rate} %`,
        category: automaticTax.kind === 'INPUT' ? 'ASSET' : 'LIABILITY',
      })
      const reverseCharge = accountAutomatic?.reverseCharge
      if (!taxCode && !automaticTax && !reverseCharge) validateKnownNonTaxAccounts(
        accounts.get(accountNumber)!, accounts.get(contraAccountNumber)!, chart, accountLength, table.name, rowIndex + 3,
      )
      if ((automaticTax || reverseCharge) && (bookingDate < SUPPORTED_TAX_START || bookingDate > SUPPORTED_TAX_END)) {
        throw new AccountingValidationError([`${table.name}, Zeile ${rowIndex + 3}: Automatische Steuerbuchungen werden nur für 2021 bis 2026 unterstützt.`])
      }
      if (reverseCharge) for (const [number, name, category] of [
        [reverseCharge.inputTaxAccountNumber, 'DATEV Vorsteuer §13b 19 %', 'ASSET'],
        [reverseCharge.outputTaxAccountNumber, 'DATEV Umsatzsteuer §13b 19 %', 'LIABILITY'],
      ] as const) if (!accounts.has(number)) accounts.set(number, { number, name, category })
      // Only DATEV's GUID is a durable cross-export identity. Canonical row data
      // can legitimately recur, so GUID-less rows must always remain importable.
      const identity = guid || null
      bookings.push({
        bookingDate,
        amountCents,
        side,
        accountNumber,
        contraAccountNumber,
        documentNumber: sourceDocument,
        description,
        ...(taxCode ? { taxCode } : {}),
        ...(automaticTax ? { automaticTax } : {}),
        ...(reverseCharge ? { reverseCharge } : {}),
        ...(generalReversal === '1' ? { generalReversal: true } : {}),
        identity,
      })
    })
  }
  if (bookings.length === 0) throw new AccountingValidationError(['Der DATEV-Buchungsstapel enthält keine Buchungen.'])
  return {
    accounts: [...accounts.values()].sort((a, b) => a.number - b.number), bookings, chart,
    consultantNumber, clientNumber, accountLength,
    masterAccountNumbers: [...masterNames.keys()].sort((a, b) => a - b),
  }
}

export function inferDatevAccountCategory(number: number, chart: DatevChart, accountLength = 4): AccountCategory {
  const personalAccountStart = 10 ** accountLength
  if (number >= personalAccountStart) return number >= 7 * personalAccountStart ? 'LIABILITY' : 'ASSET'
  if (number >= 9 * 10 ** (accountLength - 1)) return 'EQUITY'
  if (chart === 'SKR04') {
    if (number < 2 * 10 ** (accountLength - 1)) return 'ASSET'
    if (number < 3 * 10 ** (accountLength - 1)) return 'EQUITY'
    if (number < 4 * 10 ** (accountLength - 1)) return 'LIABILITY'
    if (number < 5 * 10 ** (accountLength - 1)) return 'REVENUE'
    if (number < 7 * 10 ** (accountLength - 1)) return 'EXPENSE'
    throw new AccountingValidationError([`SKR04-Konto ${number} kann keiner unterstützten Abschlusskategorie sicher zugeordnet werden.`])
  }
  const scale = 10 ** (accountLength - 4)
  const normalized = number / scale
  if (normalized > 0 && normalized < 600) return 'ASSET'
  if (normalized >= 600 && normalized < 800) return 'LIABILITY'
  if (normalized === 800) return 'EQUITY'
  if (normalized >= 840 && normalized < 900) return 'EQUITY'
  if (normalized >= 1000 && normalized < 1600) return 'ASSET'
  if (normalized >= 7000 && normalized < 8000) return 'ASSET'
  if (normalized >= 1600 && normalized < 1800) return 'LIABILITY'
  if ((normalized >= 1800 && normalized < 2000) || (normalized >= 2800 && normalized < 3000)) return 'EQUITY'
  if (normalized >= 2000 && normalized < 2500) return 'EXPENSE'
  if (normalized >= 2500 && normalized < 2800) return 'REVENUE'
  if (normalized >= 3000 && normalized < 5000) return 'EXPENSE'
  if (normalized >= 8000 && normalized < 9000) return 'REVENUE'
  throw new AccountingValidationError([`SKR03-Konto ${number} kann keiner unterstützten Abschlusskategorie sicher zugeordnet werden.`])
}

function detectDatevChart(table: DatevTable, accountLength: number): DatevChart {
  const declared = table.metadata[26]?.trim()
  if (declared === '03') return 'SKR03'
  if (declared === '04') return 'SKR04'
  if (declared) throw new AccountingValidationError([`${table.name}: Sachkontenrahmen ${declared} wird nicht unterstützt.`])
  const accountHeader = table.headers.indexOf('Konto')
  const contraHeader = table.headers.indexOf('Gegenkonto (ohne BU-Schlüssel)')
  const scale = 10 ** (accountLength - 4)
  const numbers = new Set(table.rows.flatMap(row => [Math.floor(Number(row[accountHeader]) / scale), Math.floor(Number(row[contraHeader]) / scale)]))
  const skr03 = [1200, 1576, 1600, 1776, 4930, 8400].filter(number => numbers.has(number)).length
  const skr04 = [1406, 1800, 3300, 3806, 4400, 6815].filter(number => numbers.has(number)).length
  if (skr03 > 0 && skr04 === 0) return 'SKR03'
  if (skr04 > 0 && skr03 === 0) return 'SKR04'
  throw new AccountingValidationError([`${table.name}: Der Sachkontenrahmen fehlt oder ist nicht eindeutig. Unterstützt werden SKR03 und SKR04.`])
}

function parseAutomaticTax(code: string, chart: DatevChart, accountLength: number, fileName: string, line: number) {
  const definitions = {
    '2': { kind: 'OUTPUT', rate: 7, SKR03: 1771, SKR04: 3801 },
    '3': { kind: 'OUTPUT', rate: 19, SKR03: 1776, SKR04: 3806 },
    '8': { kind: 'INPUT', rate: 7, SKR03: 1571, SKR04: 1401 },
    '9': { kind: 'INPUT', rate: 19, SKR03: 1576, SKR04: 1406 },
  } as const
  const definition = definitions[code as keyof typeof definitions]
  if (!definition) throw new AccountingValidationError([`${fileName}, Zeile ${line}: Automatik-Steuerschlüssel ${code} wird nicht unterstützt.`])
  return { kind: definition.kind, rate: definition.rate, accountNumber: definition[chart] * 10 ** (accountLength - 4) }
}

function normalizeDatevTaxCode(raw: string, fileName: string, line: number): string | undefined {
  if (!raw) return undefined
  if (!/^\d{1,4}$/.test(raw)) throw new AccountingValidationError([`${fileName}, Zeile ${line}: BU-Schlüssel muss aus höchstens vier Ziffern bestehen.`])
  const normalized = String(Number(raw))
  return normalized === '0' ? undefined : normalized
}

function automaticAccountTax(accountNumber: number, contraAccountNumber: number, chart: DatevChart, accountLength: number) {
  const scale = 10 ** (accountLength - 4)
  const account = Math.floor(accountNumber / scale)
  const contra = Math.floor(contraAccountNumber / scale)
  const numbers = new Set([account, contra])
  const output = chart === 'SKR03'
    ? [{ base: 8400, rate: 19 as const, tax: 1776 }, { base: 8300, rate: 7 as const, tax: 1771 }]
    : [{ base: 4400, rate: 19 as const, tax: 3806 }, { base: 4300, rate: 7 as const, tax: 3801 }]
  const outputMatch = output.find(item => numbers.has(item.base))
  if (outputMatch) return { automaticTax: {
    kind: 'OUTPUT' as const, rate: outputMatch.rate, accountNumber: outputMatch.tax * scale,
  } }
  const input = chart === 'SKR03'
    ? [{ base: 3400, rate: 19 as const, tax: 1576 }, { base: 3300, rate: 7 as const, tax: 1571 }]
    : [{ base: 5400, rate: 19 as const, tax: 1406 }, { base: 5300, rate: 7 as const, tax: 1401 }]
  const inputMatch = input.find(item => numbers.has(item.base))
  if (inputMatch) return { automaticTax: {
    kind: 'INPUT' as const, rate: inputMatch.rate, accountNumber: inputMatch.tax * scale,
  } }
  const reverseAccounts = chart === 'SKR03' ? [3123, 3125] : [5923, 5925]
  if (reverseAccounts.some(number => numbers.has(number))) return { reverseCharge: {
    rate: 19 as const,
    inputTaxAccountNumber: (chart === 'SKR03' ? 1577 : 1407) * scale,
    outputTaxAccountNumber: (chart === 'SKR03' ? 1787 : 3837) * scale,
    baseSide: reverseAccounts.includes(account) ? 'ACCOUNT' as const : 'CONTRA' as const,
  } }
  return undefined
}

function validateKnownNonTaxAccounts(account: DatevAccount, contra: DatevAccount, chart: DatevChart, accountLength: number, fileName: string, line: number) {
  const scale = 10 ** (accountLength - 4)
  const known = chart === 'SKR03' ? new Set([4124, 4380, 4970, 8000]) : new Set([4000])
  const unknown = [account, contra].find(candidate =>
    (candidate.category === 'REVENUE' || candidate.category === 'EXPENSE') && !known.has(Math.floor(candidate.number / scale)),
  )
  if (unknown) throw new AccountingValidationError([`${fileName}, Zeile ${line}: Das Steuerverhalten von Konto ${unknown.number} ist ohne BU-Schlüssel nicht eindeutig.`])
}

function determineAutomaticTaxSide(kind: 'INPUT' | 'OUTPUT', account: DatevAccount, contra: DatevAccount, accountLength: number, fileName: string, line: number) {
  const personalStart = 10 ** accountLength
  const taxBaseScore = (candidate: DatevAccount) => kind === 'OUTPUT'
    ? (candidate.category === 'REVENUE' ? 2 : 0)
    : candidate.category === 'EXPENSE' ? 2 : (candidate.category === 'ASSET' && candidate.number < personalStart ? 1 : 0)
  const accountScore = taxBaseScore(account)
  const contraScore = taxBaseScore(contra)
  if (accountScore !== contraScore && Math.max(accountScore, contraScore) > 0) return accountScore > contraScore ? 'ACCOUNT' as const : 'CONTRA' as const
  throw new AccountingValidationError([`${fileName}, Zeile ${line}: Das steuerpflichtige Konto für BU-Schlüssel kann nicht eindeutig bestimmt werden.`])
}

function parseAccountLength(table: DatevTable) {
  const length = Number(table.metadata[13])
  if (length !== 4) throw new AccountingValidationError([`${table.name}: Derzeit wird nur die DATEV-Sachkontenlänge 4 unterstützt.`])
  return length
}

function parseDatevFile(file: DatevFile, recordBudget: number): DatevTable | null {
  if (!file.name.toLowerCase().endsWith('.csv')) throw new AccountingValidationError([`${file.name}: Nur CSV-Dateien können importiert werden.`])
  const text = decodeDatevText(file.bytes).replace(/^\uFEFF/, '')
  const metadata = parseCsvMetadata(text)
  if (!isDatevMarker(metadata[0])) throw new AccountingValidationError([`${file.name}: Keine gültige DATEV-EXTF/DTVF-Datei.`])
  if (!['Buchungsstapel', 'Debitoren/Kreditoren'].includes(metadata[3])) return null
  const records = parseCsv(text, recordBudget).filter(row => row.some(cell => cell.length > 0))
  if (records.length < 2 || !isDatevMarker(records[0][0])) throw new AccountingValidationError([`${file.name}: Keine gültige DATEV-EXTF/DTVF-Datei.`])
  return { metadata: records[0], headers: records[1], rows: records.slice(2), name: file.name }
}

function isDatevMarker(value: string | undefined) { return value === 'EXTF' || value === 'DTVF' }

function parseCsvMetadata(text: string): string[] {
  try {
    const records = parse(text, {
      delimiter: ';', quote: '"', escape: '"', relax_column_count: true, skip_empty_lines: true, to: 1,
    }) as string[][]
    return records[0] ?? []
  } catch {
    throw new AccountingValidationError(['Die DATEV-CSV-Datei ist syntaktisch ungültig.'])
  }
}

export function consumeDatevRecordBudget(remaining: number, records: number) {
  if (records > remaining) throw new AccountingValidationError([`Ein DATEV-Import darf höchstens ${MAX_IMPORT_RECORDS} CSV-Datensätze enthalten.`])
  return remaining - records
}

function decodeDatevText(bytes: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('windows-1252').decode(bytes) }
}

export function parseCsv(text: string, maximumRecords = 50_000): string[][] {
  let records = 0
  try {
    return parse(text, {
      delimiter: ';', quote: '"', escape: '"', relax_column_count: true, skip_empty_lines: true,
      on_record: record => { if (++records > maximumRecords) throw new Error('record limit'); return record },
    }) as string[][]
  } catch {
    throw new AccountingValidationError(['Die DATEV-CSV-Datei ist syntaktisch ungültig.'])
  }
}

function value(table: DatevTable, row: string[], header: string): string {
  const found = optionalValue(table, row, header)
  if (found === undefined) throw new AccountingValidationError([`${table.name}: Pflichtspalte „${header}“ fehlt.`])
  return found
}

function optionalValue(table: DatevTable, row: string[], header: string): string | undefined {
  const index = table.headers.indexOf(header)
  return index < 0 ? undefined : (row[index] ?? '')
}

function firstPresent(table: DatevTable, row: string[], headers: string[]) {
  return headers.map(header => optionalValue(table, row, header)?.trim()).find(Boolean) ?? ''
}

function validateDatevText(raw: string, maximumLength: number, fileName: string, field: string, line?: number) {
  const location = `${fileName}${line ? `, Zeile ${line}` : ''}`
  if (raw.length > maximumLength) throw new AccountingValidationError([`${location}: ${field} darf höchstens ${maximumLength} Zeichen enthalten.`])
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new AccountingValidationError([`${location}: ${field} enthält unzulässige Steuerzeichen.`])
  return raw
}

function parseAccount(raw: string, fileName: string, accountLength: number) {
  if (!/^\d+$/.test(raw) || Number(raw) === 0 || raw.length > accountLength + 1) throw new AccountingValidationError([`${fileName}: Ungültige DATEV-Kontonummer „${raw}“.`])
  return Number(raw)
}

function parseMetadataDate(raw: string, fileName: string, label: string) {
  if (!/^\d{8}$/.test(raw)) throw new AccountingValidationError([`${fileName}: ${label} fehlt oder ist ungültig.`])
  const year = Number(raw.slice(0, 4)); const month = Number(raw.slice(4, 6)); const day = Number(raw.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new AccountingValidationError([`${fileName}: ${label} fehlt oder ist ungültig.`])
  return raw
}

function parseBookingDate(raw: string, year: number, fileName: string, line: number) {
  if (!/^\d{4}$/.test(raw)) throw new AccountingValidationError([`${fileName}, Zeile ${line}: Ungültiges Belegdatum „${raw}“.`])
  const day = Number(raw.slice(0, 2)); const month = Number(raw.slice(2, 4))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new AccountingValidationError([`${fileName}, Zeile ${line}: Ungültiges Belegdatum „${raw}“.`])
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseDatevAmount(raw: string, fileName: string, line: number) {
  if (!/^\d+(?:,\d{1,2})?$/.test(raw)) throw new AccountingValidationError([`${fileName}, Zeile ${line}: Ungültiger Umsatz „${raw}“.`])
  const [euros, fraction = ''] = raw.split(',')
  const cents = Number(euros) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents) || cents <= 0 || cents > MAX_DATABASE_CENTS) throw new AccountingValidationError([`${fileName}, Zeile ${line}: Umsatz liegt außerhalb des unterstützten Bereichs.`])
  return cents
}
