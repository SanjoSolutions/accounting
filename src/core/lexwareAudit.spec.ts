import { describe, expect, it } from 'vitest'
import { isLexwareAuditExport, parseLexwareAuditFiles, type LexwareAuditFile } from './lexwareAudit'

describe('Lexware Betriebsprüfung export parser', () => {
  it('auto-detects and parses multiple fiscal years with linked PDF documents', () => {
    const files = exportFiles([2024, 2025])
    expect(isLexwareAuditExport(files)).toBe(true)
    const parsed = parseLexwareAuditFiles(files)
    expect(parsed).toMatchObject({ chart: 'SKR03', accountLength: 4, years: [2024, 2025] })
    expect(parsed.fiscalYears).toEqual([
      { year: 2024, startsAt: '2024-01-01', endsAt: '2024-12-31' },
      { year: 2025, startsAt: '2025-01-01', endsAt: '2025-12-31' },
    ])
    expect(parsed.bookings).toHaveLength(2)
    expect(parsed.accounts).toEqual([
      { number: 1200, name: 'Bank', category: 'ASSET' },
      { number: 4930, name: 'Office supplies', category: 'EXPENSE' },
      { number: 70001, name: 'Lieferant', category: 'LIABILITY' },
    ])
    expect(parsed.bookings[1]).toMatchObject({
      year: 2025,
      bookingNumber: 1,
      bookingDate: '2025-01-17',
      documentNumber: 'R-1',
      documentName: 'MemoStorage_2025.pdf',
      lines: [
        { accountNumber: 4930, debitCents: 10000, creditCents: 0 },
        { accountNumber: 70001, debitCents: 0, creditCents: 10000 },
      ],
    })
    expect(parsed.documents.get('memostorage_2025.pdf')?.bytes).toEqual(pdf())
  })

  it('turns negative Lexware cancellation amounts into reversed positive posting lines', () => {
    const files = exportFiles([2025], {
      journalRows: [journalRow(2025, { bookingNumber: '2', documentNumber: 'R-2', text: '<Storno> Einkauf', amount: '-100,00', debit: '-100,00', credit: '-100,00', document: '' })],
    })
    expect(parseLexwareAuditFiles(files).bookings[0].lines).toEqual([
      { accountNumber: 4930, debitCents: 0, creditCents: 10000 },
      { accountNumber: 70001, debitCents: 10000, creditCents: 0 },
    ])
  })

  it('resolves two-digit dates against the journal fiscal year', () => {
    expect(parseLexwareAuditFiles(exportFiles([1999])).bookings[0].bookingDate).toBe('1999-01-17')
    expect(parseLexwareAuditFiles(exportFiles([2101])).bookings[0].bookingDate).toBe('2101-01-17')
  })

  it('uses shifted fiscal-year boundaries from company metadata', () => {
    const parsed = parseLexwareAuditFiles(exportFiles([2025], {
      period: '01.10. - 30.09.',
      journalRows: [journalRow(2025, { date: '17.10.24' })],
    }))
    expect(parsed.fiscalYears).toEqual([{ year: 2025, startsAt: '2024-10-01', endsAt: '2025-09-30' }])
    expect(parsed.bookings[0].bookingDate).toBe('2024-10-17')
  })

  it('rejects a non-EUR Lexware base currency', () => {
    expect(() => parseLexwareAuditFiles(exportFiles([2025], { currency: 'USD' }))).toThrow(/Nur EUR/)
  })

  it('derives a configured five-digit Sachkonten length from the export width', () => {
    const files = exportFiles([2025], { extraAccounts: [
      ['048300', 'Fallback expense', 'Unbekannt'],
      ['084000', 'Fallback revenue', 'Unbekannt'],
    ] }).map(file => /^(?:KTPL|jour)_BP/i.test(file.name) ? {
      ...file,
      bytes: bytes(new TextDecoder().decode(file.bytes)
        .replaceAll('01200', '012000').replaceAll('04930', '049300').replaceAll('70001', '700001')),
    } : file)
    const parsed = parseLexwareAuditFiles(files)
    expect(parsed).toMatchObject({ accountLength: 5 })
    expect(parsed.accounts.find(account => account.number === 48300)?.category).toBe('EXPENSE')
    expect(parsed.accounts.find(account => account.number === 84000)?.category).toBe('REVENUE')
  })

  it('accepts the padded width required by eight-digit Sachkonten', () => {
    const files = exportFiles([2025]).map(file => /^(?:KTPL|jour)_BP/i.test(file.name) ? {
      ...file,
      bytes: bytes(new TextDecoder().decode(file.bytes)
        .replaceAll('01200', '000012000').replaceAll('04930', '000049300').replaceAll('70001', '000070001')),
    } : file)
    expect(parseLexwareAuditFiles(files)).toMatchObject({ accountLength: 8 })
  })

  it('preserves explicit input-tax splits as three balanced lines', () => {
    const files = exportFiles([2025], {
      journalRows: [journalRow(2025, { bookingNumber: '3', documentNumber: 'R-3', amount: '119,00', debit: '100,00', credit: '119,00', taxAccount: '01576', taxAmount: '19,00', document: '' })],
      extraAccounts: [['01576', 'Vorsteuer', 'Vorsteuer']],
    })
    expect(parseLexwareAuditFiles(files).bookings[0].lines).toEqual([
      { accountNumber: 4930, debitCents: 10000, creditCents: 0 },
      { accountNumber: 70001, debitCents: 0, creditCents: 11900 },
      { accountNumber: 1576, debitCents: 1900, creditCents: 0 },
    ])
  })

  it('requires the GDPdU index, per-year tables, referenced documents, and valid balances', () => {
    expect(isLexwareAuditExport([{ name: 'EXTF.csv' }])).toBe(false)
    expect(() => parseLexwareAuditFiles(exportFiles([2025]).filter(file => file.name !== 'MemoStorage_2025.pdf'))).toThrow(/Beleg.*fehlt/)
    expect(() => parseLexwareAuditFiles(exportFiles([2025], {
      journalRows: [journalRow(2025, { debit: '99,00' })],
    }))).toThrow(/Buchungsbetrag/)
    expect(() => parseLexwareAuditFiles(exportFiles([2025], { pdfBytes: bytes('not a pdf') }))).toThrow(/ungültiges Dateiformat/)
  })

  it('retains supported non-PDF evidence in its original format', () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1])
    const parsed = parseLexwareAuditFiles(exportFiles([2025], { documentExtension: 'png', pdfBytes: pngBytes }))
    expect(parsed.documents.get('memostorage_2025.png')).toMatchObject({ contentType: 'image/png', bytes: pngBytes })
  })

  it('rejects unsafe document paths and groups split rows by booking identity', () => {
    expect(() => parseLexwareAuditFiles(exportFiles([2025], {
      journalRows: [journalRow(2025, { document: '..\\secret.pdf' })],
    }))).toThrow(/Ungültiger Beleglink/)
    const grouped = parseLexwareAuditFiles(exportFiles([2025], {
      journalRows: [journalRow(2025), journalRow(2025, { text: 'Zweiter Teil' })],
    }))
    expect(grouped.bookings).toHaveLength(1)
    expect(grouped.bookings[0].lines).toHaveLength(4)
    expect(grouped.bookings[0].description).toBe('Einkauf | Zweiter Teil')
    expect(() => parseLexwareAuditFiles(exportFiles([2025], {
      journalRows: [journalRow(2025), journalRow(2025, { documentNumber: 'R-2' })],
    }))).toThrow(/widersprüchliche Belegdaten/)
  })

  it('caps posting lines independently from distinct booking identities', () => {
    expect(() => parseLexwareAuditFiles(exportFiles([2025], {
      journalRows: Array.from({ length: 501 }, () => journalRow(2025)),
    }))).toThrow(/mehr als 1000 Buchungszeilen/)
  })

  it('rejects excessive source rows before materializing table objects', () => {
    const files = exportFiles([2025])
    const journal = files.find(file => file.name === 'jour_bp2025.txt')!
    journal.bytes = bytes(`${journalHeaders.join('\t')}\r${'x\r'.repeat(50_001)}`)
    expect(() => parseLexwareAuditFiles(files)).toThrow(/mehr als 50000 Datenzeilen/)
  })

  it('enforces the distinct-account cap while accumulating multiple years', () => {
    const files = exportFiles([2024, 2025])
    for (const [year, start] of [[2024, 10_000], [2025, 15_000]] as const) {
      const chart = files.find(file => file.name === `KTPL_BP${year}.txt`)!
      const generated = Array.from({ length: 5_001 }, (_, index) => [String(start + index), `Account ${start + index}`, 'Betriebsausgaben'])
      chart.bytes = bytes(table(CHART_TEST_HEADERS, [
        ['01200', 'Bank', 'Finanzkonto'], ['04930', 'Office supplies', 'Betriebsausgaben'], ['70001', 'Lieferant', 'Kreditoren'],
        ...generated,
      ]))
    }
    expect(() => parseLexwareAuditFiles(files)).toThrow(/höchstens 10000 Konten/)
  })
})

function exportFiles(years: number[], options: {
  journalRows?: string[][]
  extraAccounts?: string[][]
  pdfBytes?: Uint8Array
  period?: string
  currency?: string
  documentExtension?: string
} = {}): LexwareAuditFile[] {
  const result: LexwareAuditFile[] = [file('index.xml', '<?xml version="1.0"?><!DOCTYPE DataSet SYSTEM "gdpdu-01-08-2002.dtd"><DataSet></DataSet>')]
  for (const year of years) {
    result.push(file(`firma_bp${year}.txt`, table(
      ['Name', 'Grundkontenplan', 'Wirtschaftsjahr', 'Währung'],
      [['Example GmbH', 'SKR-03', options.period ?? '01.01. - 31.12.', options.currency ?? '€']],
    )))
    result.push(file(`KTPL_BP${year}.txt`, table(
      ['Konto-Nummer', 'Kontenbezeichnung', 'Kontenkategorie'],
      [
        ['01200', 'Bank', 'Finanzkonto'],
        ['04930', 'Office supplies', 'Betriebsausgaben'],
        ['70001', 'Lieferant', 'Kreditoren'],
        ...(options.extraAccounts ?? []),
      ],
    )))
    const documentName = `MemoStorage_${year}.${options.documentExtension ?? 'pdf'}`
    result.push(file(`jour_bp${year}.txt`, table(journalHeaders, options.journalRows ?? [journalRow(year, { document: documentName })])))
    result.push({ name: documentName, bytes: options.pdfBytes ?? pdf() })
  }
  return result
}

function journalRow(year: number, values: {
  bookingNumber?: string; documentNumber?: string; text?: string; amount?: string; debit?: string; credit?: string
  taxAccount?: string; taxAmount?: string; document?: string; date?: string
} = {}) {
  const row = Array<string>(journalHeaders.length).fill('')
  Object.assign(row, {
    0: values.bookingNumber ?? '1', 1: values.date ?? `17.01.${String(year).slice(-2)}`,
    2: values.documentNumber ?? 'R-1', 3: values.text ?? 'Einkauf', 4: values.amount ?? '100,00',
    5: '04930', 6: values.debit ?? '100,00', 7: '70001', 8: values.credit ?? '100,00',
    9: values.taxAccount ?? '', 10: values.taxAmount ?? '', 17: values.document ?? `MemoStorage_${year}.pdf`, 18: '1',
  })
  return row
}

const journalHeaders = [
  'Buchungsnummer', 'Belegdatum', 'Belegnummer', 'Buchungstext', 'Buchungsbetrag',
  'Sollkonto', 'Sollbetrag', 'Habenkonto', 'Habenbetrag', 'USt-Konto Soll', 'USt-Betrag Soll',
  'USt-Konto Haben', 'USt-Betrag Haben', 'Buchungsdatum', 'Journaldatum', 'KSt1', 'KSt2',
  'Beleglink', 'Periode',
]
const CHART_TEST_HEADERS = ['Konto-Nummer', 'Kontenbezeichnung', 'Kontenkategorie']

function table(headers: string[], rows: string[][]) { return [headers, ...rows].map(row => row.join('\t')).join('\r\n') }
function file(name: string, content: string): LexwareAuditFile { return { name, bytes: bytes(content) } }
function bytes(content: string) { return new Uint8Array(Buffer.from(content.replaceAll('€', '\u0080'), 'latin1')) }
function pdf() { return bytes('%PDF-1.4 synthetic test document') }
