import { createHash } from 'node:crypto'
import { AccountingValidationError, type AccountCategory } from './doubleEntry'

export type DatevExportEntry = {
  id: string
  bookingDate: string
  documentNumber: string
  description: string
  lines: Array<{ accountNumber: number; category: AccountCategory; debitCents: number; creditCents: number }>
}

export type DatevExportConfig = {
  consultantNumber: string
  clientNumber: string
  fiscalYearStart: string
  periodStart: string
  periodEnd: string
  accountLength: number
  chart: 'SKR03' | 'SKR04'
  generatedAt: string
}

// DATEV header version 700, Buchungsstapel format version 13 (February 2024).
export const datevBookingHeaders = `Umsatz (ohne Soll/Haben-Kz);Soll/Haben-Kennzeichen;WKZ Umsatz;Kurs;Basis-Umsatz;WKZ Basis-Umsatz;Konto;Gegenkonto (ohne BU-Schlüssel);BU-Schlüssel;Belegdatum;Belegfeld 1;Belegfeld 2;Skonto;Buchungstext;Postensperre;Diverse Adressnummer;Geschäftspartnerbank;Sachverhalt;Zinssperre;Beleglink;Beleginfo - Art 1;Beleginfo - Inhalt 1;Beleginfo - Art 2;Beleginfo - Inhalt 2;Beleginfo - Art 3;Beleginfo - Inhalt 3;Beleginfo - Art 4;Beleginfo - Inhalt 4;Beleginfo - Art 5;Beleginfo - Inhalt 5;Beleginfo - Art 6;Beleginfo - Inhalt 6;Beleginfo - Art 7;Beleginfo - Inhalt 7;Beleginfo - Art 8;Beleginfo - Inhalt 8;KOST1 - Kostenstelle;KOST2 - Kostenstelle;Kost-Menge;EU-Land u. UStID (Bestimmung);EU-Steuersatz (Bestimmung);Abw. Versteuerungsart;Sachverhalt L+L;Funktionsergänzung L+L;BU 49 Hauptfunktionstyp;BU 49 Hauptfunktionsnummer;BU 49 Funktionsergänzung;Zusatzinformation - Art 1;Zusatzinformation- Inhalt 1;Zusatzinformation - Art 2;Zusatzinformation- Inhalt 2;Zusatzinformation - Art 3;Zusatzinformation- Inhalt 3;Zusatzinformation - Art 4;Zusatzinformation- Inhalt 4;Zusatzinformation - Art 5;Zusatzinformation- Inhalt 5;Zusatzinformation - Art 6;Zusatzinformation- Inhalt 6;Zusatzinformation - Art 7;Zusatzinformation- Inhalt 7;Zusatzinformation - Art 8;Zusatzinformation- Inhalt 8;Zusatzinformation - Art 9;Zusatzinformation- Inhalt 9;Zusatzinformation - Art 10;Zusatzinformation- Inhalt 10;Zusatzinformation - Art 11;Zusatzinformation- Inhalt 11;Zusatzinformation - Art 12;Zusatzinformation- Inhalt 12;Zusatzinformation - Art 13;Zusatzinformation- Inhalt 13;Zusatzinformation - Art 14;Zusatzinformation- Inhalt 14;Zusatzinformation - Art 15;Zusatzinformation- Inhalt 15;Zusatzinformation - Art 16;Zusatzinformation- Inhalt 16;Zusatzinformation - Art 17;Zusatzinformation- Inhalt 17;Zusatzinformation - Art 18;Zusatzinformation- Inhalt 18;Zusatzinformation - Art 19;Zusatzinformation- Inhalt 19;Zusatzinformation - Art 20;Zusatzinformation- Inhalt 20;Stück;Gewicht;Zahlweise;Forderungsart;Veranlagungsjahr;Zugeordnete Fälligkeit;Skontotyp;Auftragsnummer;Buchungstyp;USt-Schlüssel (Anzahlungen);EU-Land (Anzahlungen);Sachverhalt L+L (Anzahlungen);EU-Steuersatz (Anzahlungen);Erlöskonto (Anzahlungen);Herkunft-Kz;Buchungs GUID;KOST-Datum;SEPA-Mandatsreferenz;Skontosperre;Gesellschaftername;Beteiligtennummer;Identifikationsnummer;Zeichnernummer;Postensperre bis;Bezeichnung SoBil-Sachverhalt;Kennzeichen SoBil-Buchung;Festschreibung;Leistungsdatum;Datum Zuord. Steuerperiode;Fälligkeit;Generalumkehr (GU);Steuersatz;Land;Abrechnungsreferenz;BVV-Position;EU-Land u. UStID (Ursprung);EU-Steuersatz (Ursprung);Abw. Skontokonto`.split(';')

export function createDatevBookingBatch(config: DatevExportConfig, entries: DatevExportEntry[]): Uint8Array {
  validateConfig(config)
  if (!entries.length) throw new AccountingValidationError(['The fiscal year has no bookings to export.'])
  const metadata = [q('EXTF'), '700', '21', q('Buchungsstapel'), '13', config.generatedAt, '', q('RE'), q('Accounting'), q(''), config.consultantNumber, config.clientNumber, compact(config.fiscalYearStart), String(config.accountLength), compact(config.periodStart), compact(config.periodEnd), q(`Fibu ${config.periodEnd.slice(0, 4)}`), q('EX'), '1', '0', '1', q('EUR'), '', q(''), '', '', q(config.chart === 'SKR03' ? '03' : '04'), '', '', q(''), q('')]
  const records = entries.flatMap(entry => splitEntry(entry).map((split, splitIndex) => bookingRecord(entry, split, splitIndex)))
  if (records.length > 99_999) throw new AccountingValidationError(['A DATEV booking batch may contain at most 99,999 booking records.'])
  const content = [metadata.join(';'), datevBookingHeaders.join(';'), ...records].join('\r\n') + '\r\n'
  // DATEV officially accepts UTF-8 only with a BOM for manual/API imports.
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')])
}

export function splitEntry(entry: DatevExportEntry) {
  const debits = entry.lines.flatMap(line => line.debitCents > 0 && line.creditCents === 0 ? [{ ...line, remaining: line.debitCents }] : [])
  const credits = entry.lines.flatMap(line => line.creditCents > 0 && line.debitCents === 0 ? [{ ...line, remaining: line.creditCents }] : [])
  if (entry.lines.some(line => line.debitCents < 0 || line.creditCents < 0 || line.debitCents && line.creditCents)) throw new AccountingValidationError([`Posting ${entry.id} uses unsupported signed or double-sided lines.`])
  if (debits.reduce((sum, line) => sum + line.remaining, 0) !== credits.reduce((sum, line) => sum + line.remaining, 0)) throw new AccountingValidationError([`Posting ${entry.id} is not balanced.`])
  const splits: Array<{ amountCents: number; debitAccount: number; debitCategory: AccountCategory; creditAccount: number; creditCategory: AccountCategory }> = []
  let debitIndex = 0; let creditIndex = 0
  while (debitIndex < debits.length && creditIndex < credits.length) {
    const debit = debits[debitIndex]; const credit = credits[creditIndex]; const amountCents = Math.min(debit.remaining, credit.remaining)
    splits.push({ amountCents, debitAccount: debit.accountNumber, debitCategory: debit.category, creditAccount: credit.accountNumber, creditCategory: credit.category })
    debit.remaining -= amountCents; credit.remaining -= amountCents
    if (!debit.remaining) debitIndex++; if (!credit.remaining) creditIndex++
  }
  return splits
}

function bookingRecord(entry: DatevExportEntry, split: ReturnType<typeof splitEntry>[number], splitIndex: number) {
  const cells = Array(datevBookingHeaders.length).fill('')
  set(cells, 'Umsatz (ohne Soll/Haben-Kz)', amount(split.amountCents))
  set(cells, 'Soll/Haben-Kennzeichen', q('S'))
  set(cells, 'WKZ Umsatz', q('EUR'))
  set(cells, 'Konto', String(split.debitAccount))
  set(cells, 'Gegenkonto (ohne BU-Schlüssel)', String(split.creditAccount))
  if (split.debitCategory === 'REVENUE' || split.debitCategory === 'EXPENSE' || split.creditCategory === 'REVENUE' || split.creditCategory === 'EXPENSE') set(cells, 'BU-Schlüssel', q('0040'))
  set(cells, 'Belegdatum', entry.bookingDate.slice(8, 10) + entry.bookingDate.slice(5, 7))
  set(cells, 'Belegfeld 1', q(sanitizeDocumentNumber(entry.documentNumber)))
  set(cells, 'Buchungstext', q(sanitizeText(entry.description, 60)))
  set(cells, 'Buchungs GUID', q(deterministicGuid(entry.id, splitIndex)))
  return cells.join(';')
}

function validateConfig(config: DatevExportConfig) {
  if (!/^\d{4,7}$/.test(config.consultantNumber) || Number(config.consultantNumber) < 1001) throw new AccountingValidationError(['A valid DATEV consultant number is required.'])
  if (!/^\d{1,5}$/.test(config.clientNumber) || Number(config.clientNumber) < 1) throw new AccountingValidationError(['A valid DATEV client number is required.'])
  if (!Number.isInteger(config.accountLength) || config.accountLength < 4 || config.accountLength > 8) throw new AccountingValidationError(['DATEV account length must be between 4 and 8.'])
  if (!/^20\d{15}$/.test(config.generatedAt)) throw new AccountingValidationError(['DATEV generation timestamp must be YYYYMMDDHHMMSSFFF.'])
  if (config.fiscalYearStart.slice(0, 4) !== config.periodEnd.slice(0, 4)) throw new AccountingValidationError(['Deviating DATEV fiscal years are not supported by this verified export scope.'])
}

function deterministicGuid(id: string, split: number) { const hash = createHash('sha256').update(`${id}:${split}`).digest('hex'); return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`.toUpperCase() }
function compact(date: string) { return date.replaceAll('-', '') }
function amount(cents: number) { return `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')}` }
function q(value: string) { return `"${value.replaceAll('"', '""')}"` }
function sanitizeText(value: string, max: number) { return value.replace(/[\r\n\t;]/g, ' ').trim().slice(0, max) }
function sanitizeDocumentNumber(value: string) { return sanitizeText(value, 36).replace(/[^\w$&%*+\-/]/g, '-').slice(0, 36) }
function set(row: string[], header: string, value: string) { row[datevBookingHeaders.indexOf(header)] = value }
