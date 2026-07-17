import { parse } from 'csv-parse/sync'
import { AccountingValidationError, MAX_DATABASE_CENTS, type AccountCategory } from './doubleEntry'

export type LexwareAuditFile = { name: string; bytes: Uint8Array }
export type LexwareAuditDocument = LexwareAuditFile & { contentType: string }

export type LexwareAuditFiscalYear = {
  year: number
  startsAt: string
  endsAt: string
}

export type LexwareAuditAccount = {
  number: number
  name: string
  category: AccountCategory
}

export type LexwareAuditLine = {
  accountNumber: number
  debitCents: number
  creditCents: number
}

export type LexwareAuditBooking = {
  year: number
  bookingNumber: number
  bookingDate: string
  documentNumber: string
  description: string
  lines: LexwareAuditLine[]
  documentName: string | null
}

export type LexwareAuditImport = {
  chart: 'SKR03' | 'SKR04'
  accountLength: number
  accounts: LexwareAuditAccount[]
  bookings: LexwareAuditBooking[]
  documents: Map<string, LexwareAuditDocument>
  fiscalYears: LexwareAuditFiscalYear[]
  years: number[]
}

const JOURNAL_PATTERN = /^jour_bp(\d{4})\.txt$/i
const MAX_YEARS = 100
const MAX_BOOKINGS = 20_000
const MAX_JOURNAL_ROWS = 50_000
const MAX_POSTING_LINES = 100_000
const MAX_LINES_PER_BOOKING = 1_000
const MAX_ACCOUNTS = 10_000
const MAX_DOCUMENTS = 5_000

export function isLexwareAuditExport(files: ArrayLike<{ name: string }>) {
  const names = Array.from(files).map(file => leafName(file.name).toLowerCase())
  return names.includes('index.xml') && names.some(name => JOURNAL_PATTERN.test(name))
}

export function parseLexwareAuditFiles(files: LexwareAuditFile[]): LexwareAuditImport {
  if (!isLexwareAuditExport(files)) {
    throw new AccountingValidationError(['Der ausgewählte Ordner ist kein Lexware-Buchhaltung-Export „Daten Betriebsprüfung“.'])
  }
  const byName = indexFiles(files)
  validateIndex(byName.get('index.xml')!)
  const journalFiles = [...byName.entries()]
    .flatMap(([name, file]) => {
      const match = JOURNAL_PATTERN.exec(name)
      return match ? [{ year: Number(match[1]), file }] : []
    })
    .sort((left, right) => left.year - right.year)
  if (journalFiles.length > MAX_YEARS) throw new AccountingValidationError([`Ein Lexware-Import darf höchstens ${MAX_YEARS} Geschäftsjahre enthalten.`])

  const charts = new Set<'SKR03' | 'SKR04'>()
  const accountLengths = new Set<number>()
  const fiscalYears: LexwareAuditFiscalYear[] = []
  const accounts = new Map<number, LexwareAuditAccount>()
  const bookingGroups = new Map<string, LexwareAuditBooking & { descriptions: Set<string> }>()
  const referencedDocuments = new Map<string, string>()
  let journalRows = 0
  let postingLines = 0

  for (const { year, file } of journalFiles) {
    validateYear(year)
    const company = requiredFile(byName, `firma_bp${year}.txt`)
    const companyMetadata = parseCompanyMetadata(company, year)
    const chart = companyMetadata.chart
    charts.add(chart)
    fiscalYears.push(companyMetadata.fiscalYear)
    const chartRows = parseTable(requiredFile(byName, `ktpl_bp${year}.txt`), CHART_HEADERS, MAX_ACCOUNTS)
    const accountLength = parseAccountLength(chartRows, year)
    accountLengths.add(accountLength)
    const chartByNumber = new Map<number, LexwareAuditAccount>()
    for (const row of chartRows) {
      const number = parseAccount(row['Konto-Nummer'], `KTPL_BP${year}.txt`)
      const account = {
        number,
        name: requiredText(row['Kontenbezeichnung'], `KTPL_BP${year}.txt: Konto ${number} hat keine Bezeichnung.`),
        category: lexwareCategory(row.Kontenkategorie, row['Konto-Nummer'], chart),
      }
      const previous = accounts.get(number)
      if (previous && previous.category !== account.category) {
        throw new AccountingValidationError([`KTPL_BP${year}.txt: Konto ${number} wechselt zwischen Abschlusskategorien.`])
      }
      accounts.set(number, account)
      if (accounts.size > MAX_ACCOUNTS) throw new AccountingValidationError([`Ein Lexware-Import darf höchstens ${MAX_ACCOUNTS} Konten enthalten.`])
      chartByNumber.set(number, account)
    }
    const rows = parseTable(file, JOURNAL_HEADERS, MAX_JOURNAL_ROWS - journalRows)
    journalRows += rows.length
    if (journalRows > MAX_JOURNAL_ROWS) throw new AccountingValidationError([`Ein Lexware-Import darf höchstens ${MAX_JOURNAL_ROWS} Journalzeilen enthalten.`])
    for (const [index, row] of rows.entries()) {
      const location = `${file.name}, Zeile ${index + 2}`
      const bookingNumber = parsePositiveInteger(row.Buchungsnummer, `${location}: Ungültige Buchungsnummer.`)
      const key = `${year}:${bookingNumber}`
      const bookingDate = parseLexwareDate(row.Belegdatum, companyMetadata.fiscalYear, location)
      const lines = parsePartialLines(row, location)
      validateDeclaredBookingAmount(row.Buchungsbetrag, lines, location)
      postingLines += lines.length
      if (postingLines > MAX_POSTING_LINES) throw new AccountingValidationError([`Ein Lexware-Import darf höchstens ${MAX_POSTING_LINES} Buchungszeilen enthalten.`])
      const usedNumbers = new Set(lines.map(line => line.accountNumber))
      for (const number of usedNumbers) {
        if (!chartByNumber.has(number)) throw new AccountingValidationError([`${location}: Konto ${number} fehlt im Lexware-Kontenplan ${year}.`])
      }
      const documentName = normalizeDocumentName(row.Beleglink, location)
      if (documentName) referencedDocuments.set(documentName.toLowerCase(), documentName)
      const documentNumber = row.Belegnummer.trim()
      const description = requiredText(row.Buchungstext, `${location}: Der Buchungstext fehlt.`)
      const existingGroup = bookingGroups.get(key)
      if (existingGroup) {
        if (existingGroup.bookingDate !== bookingDate || existingGroup.documentNumber !== documentNumber ||
          existingGroup.documentName?.toLowerCase() !== documentName?.toLowerCase()) {
          throw new AccountingValidationError([`${location}: Die Teilzeilen der Buchungsnummer ${bookingNumber} haben widersprüchliche Belegdaten.`])
        }
        if (existingGroup.lines.length + lines.length > MAX_LINES_PER_BOOKING) {
          throw new AccountingValidationError([`${location}: Buchungsnummer ${bookingNumber} enthält mehr als ${MAX_LINES_PER_BOOKING} Buchungszeilen.`])
        }
        existingGroup.descriptions.add(description)
        existingGroup.lines.push(...lines)
      } else {
        if (bookingGroups.size >= MAX_BOOKINGS) throw new AccountingValidationError([`Ein Lexware-Import darf höchstens ${MAX_BOOKINGS} Buchungen enthalten.`])
        if (lines.length > MAX_LINES_PER_BOOKING) throw new AccountingValidationError([`${location}: Buchungsnummer ${bookingNumber} enthält zu viele Buchungszeilen.`])
        bookingGroups.set(key, {
          year,
          bookingNumber,
          bookingDate,
          documentNumber,
          description,
          descriptions: new Set([description]),
          lines,
          documentName,
        })
      }
    }
  }
  if (charts.size !== 1) throw new AccountingValidationError(['Die Lexware-Geschäftsjahre verwenden unterschiedliche Kontenrahmen.'])
  if (accountLengths.size !== 1) throw new AccountingValidationError(['Die Lexware-Geschäftsjahre verwenden unterschiedliche Sachkontenlängen.'])
  if (accounts.size > MAX_ACCOUNTS) throw new AccountingValidationError([`Ein Lexware-Import darf höchstens ${MAX_ACCOUNTS} verwendete Konten enthalten.`])
  if (referencedDocuments.size > MAX_DOCUMENTS) throw new AccountingValidationError([`Ein Lexware-Import darf höchstens ${MAX_DOCUMENTS} Belege enthalten.`])

  const documents = new Map<string, LexwareAuditDocument>()
  for (const [normalized, original] of referencedDocuments) {
    const document = byName.get(normalized)
    if (!document) throw new AccountingValidationError([`Der in einem Journal referenzierte Beleg „${original}“ fehlt im Ordner BELEGE.`])
    const contentType = evidenceContentType(document.name, document.bytes)
    if (!contentType) throw new AccountingValidationError([`Der Beleg „${original}“ hat ein nicht unterstütztes oder ungültiges Dateiformat.`])
    documents.set(normalized, { ...document, contentType })
  }
  return {
    chart: [...charts][0],
    accountLength: [...accountLengths][0],
    accounts: [...accounts.values()].sort((left, right) => left.number - right.number),
    bookings: [...bookingGroups.values()].map(({ descriptions, ...booking }) => validateBookingLines({
      ...booking, description: [...descriptions].join(' | '),
    })),
    documents,
    fiscalYears,
    years: journalFiles.map(item => item.year),
  }
}

function indexFiles(files: LexwareAuditFile[]) {
  const result = new Map<string, LexwareAuditFile>()
  for (const file of files) {
    const normalized = leafName(file.name).toLowerCase()
    if (!normalized) throw new AccountingValidationError(['Der Lexware-Upload enthält einen ungültigen Dateinamen.'])
    if (result.has(normalized)) throw new AccountingValidationError([`Der Lexware-Upload enthält „${leafName(file.name)}“ mehrfach.`])
    result.set(normalized, { ...file, name: leafName(file.name) })
  }
  return result
}

function requiredFile(files: Map<string, LexwareAuditFile>, name: string) {
  const file = files.get(name.toLowerCase())
  if (!file) throw new AccountingValidationError([`Im Lexware-Export fehlt „${name}“.`])
  return file
}

function validateIndex(file: LexwareAuditFile) {
  const text = decodeText(file.bytes)
  if (!/^\s*<\?xml[\s\S]*?<DataSet[>\s]/i.test(text) || !/gdpdu-01-08-2002\.dtd/i.test(text)) {
    throw new AccountingValidationError(['Die index.xml ist kein gültiger Lexware-GDPdU-Index.'])
  }
}

function parseCompanyMetadata(file: LexwareAuditFile, year: number) {
  const rows = parseTable(file, ['Grundkontenplan', 'Wirtschaftsjahr', 'Währung'], 10)
  const row = rows[0]
  const raw = row?.Grundkontenplan.trim().replace(/[^A-Z0-9]/gi, '').toUpperCase()
  let chart: 'SKR03' | 'SKR04'
  if (raw === 'SKR03') chart = 'SKR03'
  else if (raw === 'SKR04') chart = 'SKR04'
  else throw new AccountingValidationError([`${file.name}: Der Kontenrahmen für ${year} ist weder SKR-03 noch SKR-04.`])
  const currency = row?.['Währung']?.trim().toUpperCase()
  if (currency !== 'EUR' && currency !== 'EURO' && currency !== '€' && currency !== '\u0080') {
    throw new AccountingValidationError([`${file.name}: Nur EUR als Basiswährung wird unterstützt.`])
  }
  return { chart, fiscalYear: parseFiscalYear(row?.Wirtschaftsjahr ?? '', year, file.name) }
}

function parseFiscalYear(raw: string, year: number, fileName: string): LexwareAuditFiscalYear {
  const match = /^(\d{2})\.(\d{2})\.\s*-\s*(\d{2})\.(\d{2})\.$/.exec(raw.trim())
  if (!match) throw new AccountingValidationError([`${fileName}: Das Wirtschaftsjahr „${raw}“ ist ungültig.`])
  const startMonth = Number(match[2]); const startDay = Number(match[1])
  const endMonth = Number(match[4]); const endDay = Number(match[3])
  const crossesYear = startMonth > endMonth || (startMonth === endMonth && startDay > endDay)
  const startYear = crossesYear ? year - 1 : year
  const startsAt = validatedIsoDate(startYear, startMonth, startDay, fileName)
  const endsAt = validatedIsoDate(year, endMonth, endDay, fileName)
  if (startsAt > endsAt) throw new AccountingValidationError([`${fileName}: Die Grenzen des Wirtschaftsjahres sind ungültig.`])
  return { year, startsAt, endsAt }
}

function parseAccountLength(rows: Record<string, string>[], year: number) {
  const widths = new Set(rows.map(row => row['Konto-Nummer']?.trim()).filter(value => /^\d+$/.test(value ?? '')).map(value => value!.length))
  if (widths.size !== 1) throw new AccountingValidationError([`KTPL_BP${year}.txt: Die Kontonummern haben keine einheitliche Länge.`])
  const exportWidth = [...widths][0]
  const accountLength = exportWidth - 1
  if (accountLength < 4 || accountLength > 8) throw new AccountingValidationError([`KTPL_BP${year}.txt: Die Sachkontenlänge ${accountLength} wird nicht unterstützt.`])
  return accountLength
}

function validatedIsoDate(year: number, month: number, day: number, location: string) {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new AccountingValidationError([`${location}: Das Wirtschaftsjahr enthält ein ungültiges Datum.`])
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseTable(file: LexwareAuditFile, requiredHeaders: string[], maximumRows: number) {
  const text = decodeText(file.bytes)
  if (countDataRows(text) > maximumRows) {
    throw new AccountingValidationError([`${file.name}: Die Tabelle enthält mehr als ${maximumRows} Datenzeilen.`])
  }
  let rows: Record<string, string>[]
  try {
    rows = parse(text, {
      columns: true,
      delimiter: '\t',
      quote: null,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: false,
      trim: false,
    }) as Record<string, string>[]
  } catch {
    throw new AccountingValidationError([`${file.name}: Die tabellarischen Daten sind syntaktisch ungültig.`])
  }
  const headers = rows.length ? Object.keys(rows[0]) : firstLine(text).split('\t')
  const missing = requiredHeaders.filter(header => !headers.includes(header))
  if (missing.length) throw new AccountingValidationError([`${file.name}: Pflichtspalten fehlen: ${missing.join(', ')}.`])
  return rows
}

function countDataRows(text: string) {
  let nonEmptyLines = 0
  let hasContent = false
  for (let index = 0; index < text.length; index++) {
    const character = text.charCodeAt(index)
    if (character === 10 || character === 13) {
      if (hasContent) nonEmptyLines++
      hasContent = false
      if (character === 13 && text.charCodeAt(index + 1) === 10) index++
    } else {
      hasContent = true
    }
  }
  if (hasContent) nonEmptyLines++
  return Math.max(0, nonEmptyLines - 1)
}

function parsePartialLines(row: Record<string, string>, location: string) {
  const candidates: Array<[string, string, 'S' | 'H']> = [
    ['Sollkonto', 'Sollbetrag', 'S'],
    ['Habenkonto', 'Habenbetrag', 'H'],
    ['USt-Konto Soll', 'USt-Betrag Soll', 'S'],
    ['USt-Konto Haben', 'USt-Betrag Haben', 'H'],
  ]
  const lines: LexwareAuditLine[] = []
  for (const [accountField, amountField, side] of candidates) {
    const accountRaw = row[accountField]?.trim() ?? ''
    const amountRaw = row[amountField]?.trim() ?? ''
    if (!accountRaw && !amountRaw) continue
    if (!accountRaw && amountRaw && parseGermanCents(amountRaw, location) === 0) continue
    if (!accountRaw || !amountRaw) throw new AccountingValidationError([`${location}: Konto und Betrag für „${accountField}“ müssen gemeinsam angegeben sein.`])
    const accountNumber = parseAccount(accountRaw, location)
    const signedCents = parseGermanCents(amountRaw, location)
    if (signedCents === 0) continue
    const effectiveSide = signedCents < 0 ? (side === 'S' ? 'H' : 'S') : side
    lines.push({
      accountNumber,
      debitCents: effectiveSide === 'S' ? Math.abs(signedCents) : 0,
      creditCents: effectiveSide === 'H' ? Math.abs(signedCents) : 0,
    })
  }
  return lines
}

function validateDeclaredBookingAmount(raw: string, lines: LexwareAuditLine[], location: string) {
  const declared = Math.abs(parseGermanCents(raw, location))
  const debit = lines.reduce((sum, line) => sum + line.debitCents, 0)
  const credit = lines.reduce((sum, line) => sum + line.creditCents, 0)
  if (declared === 0 || (debit !== 0 && debit !== declared) || (credit !== 0 && credit !== declared)) {
    throw new AccountingValidationError([`${location}: Der Buchungsbetrag stimmt nicht mit den Soll-/Habenbeträgen der Journalzeile überein.`])
  }
}

function validateBookingLines(booking: LexwareAuditBooking) {
  const debit = booking.lines.reduce((sum, line) => sum + line.debitCents, 0)
  const credit = booking.lines.reduce((sum, line) => sum + line.creditCents, 0)
  const location = `Lexware-Buchung ${booking.bookingNumber}/${booking.year}`
  if (booking.lines.length < 2 || new Set(booking.lines.map(line => line.accountNumber)).size < 2) {
    throw new AccountingValidationError([`${location}: Die Buchung enthält nicht mindestens zwei unterschiedliche Konten.`])
  }
  if (debit !== credit) throw new AccountingValidationError([`${location}: Soll und Haben unterscheiden sich um ${Math.abs(debit - credit)} Cent.`])
  return booking
}

function parseGermanCents(raw: string, location: string) {
  if (!/^-?(?:0|[1-9]\d{0,2}(?:\.\d{3})*|\d+),\d{2}$/.test(raw)) {
    throw new AccountingValidationError([`${location}: Ungültiger Betrag „${raw}“.`])
  }
  const negative = raw.startsWith('-')
  const normalized = raw.replace('-', '').replaceAll('.', '')
  const [euros, cents] = normalized.split(',')
  const value = Number(euros) * 100 + Number(cents)
  if (!Number.isSafeInteger(value) || value > MAX_DATABASE_CENTS) throw new AccountingValidationError([`${location}: Betrag liegt außerhalb des unterstützten Bereichs.`])
  return negative ? -value : value
}

function parseLexwareDate(raw: string, fiscalYear: LexwareAuditFiscalYear, location: string) {
  const match = /^(\d{2})\.(\d{2})\.(\d{2}|\d{4})$/.exec(raw.trim())
  if (!match) throw new AccountingValidationError([`${location}: Ungültiges Belegdatum „${raw}“.`])
  const startYear = Number(fiscalYear.startsAt.slice(0, 4)); const endYear = Number(fiscalYear.endsAt.slice(0, 4))
  const shortYear = Number(match[3])
  const matchingYears = [...new Set([startYear, endYear])].filter(year => year % 100 === shortYear)
  const year = match[3].length === 2 ? matchingYears[0] : Number(match[3])
  const month = Number(match[2]); const day = Number(match[1])
  const date = new Date(Date.UTC(year, month - 1, day))
  const isoDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  if (!year || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
    isoDate < fiscalYear.startsAt || isoDate > fiscalYear.endsAt) {
    throw new AccountingValidationError([`${location}: Das Belegdatum liegt nicht im Geschäftsjahr ${fiscalYear.year}.`])
  }
  return isoDate
}

function normalizeDocumentName(raw: string, location: string) {
  const name = raw.trim()
  if (!name) return null
  if (name !== leafName(name) || !/\.[a-z0-9]{2,5}$/i.test(name)) {
    throw new AccountingValidationError([`${location}: Ungültiger Beleglink „${name}“.`])
  }
  return name
}

function lexwareCategory(raw: string, rawNumber: string, chart: 'SKR03' | 'SKR04'): AccountCategory {
  const category = raw.trim()
  if (['Betriebsausgaben', 'Abschreibungen'].includes(category)) return 'EXPENSE'
  if (category === 'Einnahmen') return 'REVENUE'
  if (category === 'Kapital' || category === 'Privat' || category === 'Saldovortrag') return 'EQUITY'
  if (['Verbindlichkeiten', 'Rückstellung', 'Umsatzsteuer', 'Kreditoren', 'Erhaltene Anzahlungen', 'Passive Rechnungsabgrenzung'].includes(category)) return 'LIABILITY'
  if (['Anlagevermögen', 'Forderungen', 'Finanzkonto', 'Vorsteuer', 'Vorräte', 'Debitoren', 'Geleistete Anzahlungen', 'Aktive Rechnungsabgrenzung', 'Umlaufvermögen', 'Umsatzsteuervorauszahlung'].includes(category)) return 'ASSET'
  return inferCategoryByNumber(normalizedCategoryNumber(rawNumber), chart)
}

function normalizedCategoryNumber(raw: string) {
  const digits = raw.trim().replace(/^0+/, '')
  if (!digits) return 0
  const categoryDigits = raw.trim().startsWith('0') ? digits.slice(0, 4) : digits.slice(0, 5)
  return Number(categoryDigits)
}

function inferCategoryByNumber(number: number, chart: 'SKR03' | 'SKR04'): AccountCategory {
  if (number >= 10_000) return number >= 70_000 ? 'LIABILITY' : 'ASSET'
  if (chart === 'SKR04') {
    if (number < 2000) return 'ASSET'
    if (number < 3000) return 'EQUITY'
    if (number < 4000) return 'LIABILITY'
    if (number < 5000) return 'REVENUE'
    return 'EXPENSE'
  }
  if (number < 1600 || (number >= 1900 && number < 2000) || (number >= 7000 && number < 8000)) return 'ASSET'
  if (number < 1800) return 'LIABILITY'
  if ((number >= 1800 && number < 2000) || (number >= 2800 && number < 3000) || number >= 9000) return 'EQUITY'
  if ((number >= 2500 && number < 2800) || (number >= 8000 && number < 9000)) return 'REVENUE'
  return 'EXPENSE'
}

function validateYear(year: number) {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new AccountingValidationError([`Lexware-Geschäftsjahr ${year} wird nicht unterstützt.`])
}

function parseAccount(raw: string, location: string) {
  if (!/^\d{1,9}$/.test(raw.trim()) || Number(raw) === 0) throw new AccountingValidationError([`${location}: Ungültige Kontonummer „${raw}“.`])
  return Number(raw)
}

function parsePositiveInteger(raw: string, issue: string) {
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) throw new AccountingValidationError([issue])
  return Number(raw)
}

function requiredText(raw: string, issue: string) {
  const value = raw?.trim()
  if (!value) throw new AccountingValidationError([issue])
  return value
}

function decodeText(bytes: Uint8Array) { return new TextDecoder('windows-1252').decode(bytes).replace(/^\uFEFF/, '') }
function firstLine(text: string) { return text.split(/\r?\n/, 1)[0] }
function leafName(name: string) { return name.replaceAll('\\', '/').split('/').pop() ?? '' }

function evidenceContentType(name: string, bytes: Uint8Array) {
  const extension = name.toLowerCase().split('.').pop() ?? ''
  const ascii = (length: number) => new TextDecoder('ascii').decode(bytes.subarray(0, length))
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value)
  if (extension === 'pdf' && ascii(5) === '%PDF-') return 'application/pdf'
  if ((extension === 'jpg' || extension === 'jpeg') && starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (extension === 'png' && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (extension === 'gif' && ['GIF87a', 'GIF89a'].includes(ascii(6))) return 'image/gif'
  if (extension === 'bmp' && ascii(2) === 'BM') return 'image/bmp'
  if ((extension === 'tif' || extension === 'tiff') && (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a))) return 'image/tiff'
  if (extension === 'xml' && looksLikeXml(bytes)) return 'application/xml'
  if (extension === 'rtf' && ascii(5) === '{\\rtf') return 'application/rtf'
  if (['doc', 'xls'].includes(extension) && starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    return extension === 'doc' ? 'application/msword' : 'application/vnd.ms-excel'
  }
  if (['docx', 'xlsx', 'odt', 'ods', 'odp'].includes(extension) && starts(0x50, 0x4b)) {
    return ({
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      odt: 'application/vnd.oasis.opendocument.text',
      ods: 'application/vnd.oasis.opendocument.spreadsheet',
      odp: 'application/vnd.oasis.opendocument.presentation',
    } as Record<string, string>)[extension]
  }
  return null
}

function looksLikeXml(bytes: Uint8Array) {
  if (bytes.length < 3) return false
  if ((bytes[0] === 0xff && bytes[1] === 0xfe && bytes[2] === 0x3c && bytes[3] === 0x00) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff && bytes[2] === 0x00 && bytes[3] === 0x3c)) return true
  return new TextDecoder('utf-8').decode(bytes.subarray(0, 512)).replace(/^\uFEFF/, '').trimStart().startsWith('<')
}

const JOURNAL_HEADERS = [
  'Buchungsnummer', 'Belegdatum', 'Belegnummer', 'Buchungstext', 'Buchungsbetrag', 'Sollkonto', 'Sollbetrag',
  'Habenkonto', 'Habenbetrag', 'USt-Konto Soll', 'USt-Betrag Soll', 'USt-Konto Haben',
  'USt-Betrag Haben', 'Beleglink',
]
const CHART_HEADERS = ['Konto-Nummer', 'Kontenbezeichnung', 'Kontenkategorie']
