import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

type FilePayload = { name: string; mimeType: string; buffer: Buffer }

export const LEXWARE_2025_YEAR = 2025

export const syntheticLexware2025 = {
  company: 'Nordstern Testhandel GmbH',
  chartSearch: 'Cloud services',
  chartAccount: '4930',
  inputVatAccount: '1576',
  outputVatAccount: '1776',
  attachedBooking: 'Synthetic cloud subscription',
  outgoingBooking: 'Synthetic consulting invoice',
  unattachedBooking: 'Synthetic bank fee without voucher',
  voucher: 'synthetic-voucher-2025.pdf',
  debtor: 'Synthetic Customer Alpha',
  debtorAccount: '10001',
  creditor: 'Synthetic Supplier Beta',
  creditorAccount: '70001',
  street: 'Testallee',
  city: 'Musterstadt',
  region: 'Testland',
} as const

const journalHeaders = [
  'Buchungsnummer', 'Buchungsdatum', 'Journaldatum', 'Belegdatum', 'Belegnummer', 'Buchungstext',
  'Buchungsbetrag', 'Sollkonto', 'Sollbetrag', 'Habenkonto', 'Habenbetrag', 'USt-Konto Soll',
  'USt-Betrag Soll', 'USt-Konto Haben', 'USt-Betrag Haben', 'KSt1', 'KSt2', 'Beleglink', 'Periode',
]

/**
 * A deliberately small, wholly invented 2025 export. It mirrors the demonstrated
 * Lexware GDPdU table schemas without copying source identities or monetary data.
 */
export function createSyntheticLexware2025Files(): FilePayload[] {
  return [
    textFile('index.xml', [
      '<?xml version="1.0" encoding="windows-1252"?>',
      '<!DOCTYPE DataSet SYSTEM "gdpdu-01-08-2002.dtd">',
      '<DataSet><Version>1.0</Version></DataSet>',
    ].join('\r\n')),
    textFile('gdpdu-01-08-2002.dtd', '<!ELEMENT DataSet ANY>'),
    textFile('firma_bp2025.txt', table(
      ['Name', 'Strasse', 'PLZ', 'Ort', 'Land', 'Telefon', 'FAX', 'Währung', 'Gewinnermittlungsart', 'Grundkontenplan', 'Wirtschaftsjahr', 'Taxonomie Version'],
      [[syntheticLexware2025.company, 'Prüfweg 8', '12345', syntheticLexware2025.city, syntheticLexware2025.region, '', '', 'EUR', 'Betriebsvermögensvergleich', 'SKR-03', '01.01. - 31.12.', '6.8']],
    )),
    textFile('KTPL_BP2025.txt', table(
      ['Konto-Nummer', 'Kontenbezeichnung', 'Kontenkategorie', 'Kontenunterart', 'USt.Pos alt', 'USt. alt', 'USt.Pos neu', 'USt. neu', 'Zuordnung EÜ', 'Zuordnung Aktiva', 'Zuordnung Passiva', 'Zuordnung GuV', 'Taxonomie Aktiva', 'Taxonomie Passiva', 'Taxonomie GuV'],
      [
        ['01200', 'Synthetic bank', 'Finanzkonto', 'Bank', '', '', '', '', '', 'Bank', '', '', 'bs.ass.currAss.cashEquiv', '', ''],
        ['01576', 'Synthetic input VAT 19 percent', 'Vorsteuer', 'Vorsteuer', '', '19', '66', '19', '', 'Vorsteuer', '', '', 'bs.ass.currAss.receiv.other', '', ''],
        ['01776', 'Synthetic output VAT 19 percent', 'Umsatzsteuer', 'Umsatzsteuer', '', '19', '81', '19', '', '', 'Umsatzsteuer', '', '', 'bs.eqLiab.liab.other', ''],
        ['04930', syntheticLexware2025.chartSearch, 'Betriebsausgaben', 'Other operating expense', '', '19', '', '19', 'Sonstige Betriebsausgaben', '', '', 'Sonstige betriebliche Aufwendungen', '', '', 'is.netIncome.regular.operatingTC.otherCost'],
        ['08400', 'Synthetic service revenue', 'Einnahmen', 'Revenue', '', '19', '81', '19', 'Betriebseinnahmen', '', '', 'Umsatzerlöse', '', '', 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput.salesRevenue'],
        ['10001', syntheticLexware2025.debtor, 'Debitoren', 'Customer', '', '19', '', '19', '', 'Forderungen', '', '', 'bs.ass.currAss.receiv.trade', '', ''],
        ['70001', syntheticLexware2025.creditor, 'Kreditoren', 'Supplier', '', '19', '', '19', '', '', 'Verbindlichkeiten', '', '', 'bs.eqLiab.liab.trade', ''],
      ],
    )),
    textFile('jour_bp2025.txt', table(journalHeaders, [
      journalRow({
        bookingNumber: '501', voucherDate: '14.02.25', postingDate: '18.02.25', journalDate: '20.02.25', documentNumber: 'SYN-501',
        text: syntheticLexware2025.attachedBooking, amount: '142,80', debitAccount: '04930',
        debit: '120,00', creditAccount: '70001', credit: '142,80', taxAccount: '01576',
        tax: '22,80', document: syntheticLexware2025.voucher, period: '2',
      }),
      journalRow({
        bookingNumber: '502', voucherDate: '28.06.25', postingDate: '30.06.25', journalDate: '01.07.25', documentNumber: 'SYN-502',
        text: syntheticLexware2025.unattachedBooking, amount: '17,35', debitAccount: '04930',
        debit: '17,35', creditAccount: '01200', credit: '17,35', document: '', period: '6',
      }),
      journalRow({
        bookingNumber: '503', voucherDate: '05.09.25', postingDate: '09.09.25', journalDate: '10.09.25', documentNumber: 'SYN-503',
        text: 'Synthetic customer receipt', amount: '238,00', debitAccount: '01200',
        debit: '238,00', creditAccount: '10001', credit: '238,00', document: '', period: '9',
      }),
      journalRow({
        bookingNumber: '504', voucherDate: '14.11.25', postingDate: '18.11.25', journalDate: '19.11.25', documentNumber: 'SYN-504',
        text: syntheticLexware2025.outgoingBooking, amount: '357,00', debitAccount: '10001',
        debit: '357,00', creditAccount: '08400', credit: '300,00', taxCreditAccount: '01776',
        taxCredit: '57,00', document: '', period: '11',
      }),
    ])),
    textFile('sald_BP2025.txt', table(
      ['Konto', 'Name', 'Letzte Buchung', 'EB-Wert Soll', 'EB-Wert Haben', 'Summe für WJ Soll', 'Summe für WJ Haben', 'Summe per WJ Soll', 'Summe per WJ Haben', 'Saldo per WJ Soll', 'Saldo per WJ Haben'],
      [['04930', syntheticLexware2025.chartSearch, '30.06.2025', '10,00', '0,00', '137,35', '0,00', '147,35', '0,00', '147,35', '0,00']],
    )),
    textFile('KTO_BP_SACH_SACH2025.txt', table(
      ['Buchungsnummer', 'Kontonummer', 'Kontobezeichnung', 'Belegdatum', 'Belegnummer', 'Buchungstext', 'Gegenkonto', 'Sollbetrag €', 'Habenbetrag €', 'USt-Konto', 'USt-%'],
      [['501', '04930', syntheticLexware2025.chartSearch, '14.02.2025', 'SYN-501', syntheticLexware2025.attachedBooking, '70001', '120,00', '0,00', '01576', '19,00']],
    )),
    textFile('KTO_BP_PERS_PERS2025.txt', table(
      ['Buchungsnummer', 'Kontonummer', 'Kontobezeichnung', 'Belegdatum', 'Belegnummer', 'Buchungstext', 'Gegenkonto', 'Sollbetrag €', 'Habenbetrag €', 'USt-Konto', 'USt-%', 'Kunden-/Lieferantennummer', 'USt-IdNr.'],
      [
        ['503', '10001', syntheticLexware2025.debtor, '09.09.2025', 'SYN-503', 'Synthetic customer receipt', '01200', '0,00', '238,00', '', '0,00', 'C-10001', 'DE123450001'],
        ['504', '10001', syntheticLexware2025.debtor, '18.11.2025', 'SYN-504', syntheticLexware2025.outgoingBooking, '08400', '357,00', '0,00', '01776', '19,00', 'C-10001', 'DE123450001'],
        ['501', '70001', syntheticLexware2025.creditor, '14.02.2025', 'SYN-501', syntheticLexware2025.attachedBooking, '04930', '0,00', '142,80', '01576', '19,00', 'V-70001', 'DE123450002'],
      ],
    )),
    textFile('KTO_BP_ADR_PERS2025.txt', table(
      ['Kunden-/Lieferantennummer', 'Name', 'Strasse', 'Hausnummer', 'PLZ', 'Ort', 'Branche'],
      [
        ['C-10001', syntheticLexware2025.debtor, syntheticLexware2025.street, '11', '23456', syntheticLexware2025.city, 'Test retail'],
        ['V-70001', syntheticLexware2025.creditor, 'Beispielring', '4', '34567', 'Probestadt', 'Test software'],
      ],
    )),
    textFile('UST_BP2025.txt', table(
      ['41 Bemessungsgr.', '44 Bemessungsgr.', '49 Bemessungsgr.', '43 Bemessungsgr.', '48 Bemessungsgr.', '51 Bemessungsgr.', '51 Steuer', '81 Bemessungsgr.', '81 Steuer', '86 Bemessungsgr.', '86 Steuer', '35', '36', '77', '76', '80', '91', '97 Bemessungsgr.', '97 Steuer', '89 Bemessungsgr.', '89 Steuer', '93 Bemessungsgr.', '93 Steuer', '95', '98', '94', '96', '42', '68', '60', '21', '45', '54 Bemessungsgr.', '54 Steuer', '55 Bemessungsgr.', '55 Steuer', '57', '58', '46', '47', '52', '53', '73', '74', '78', '79', '84', '85', '65', '66', '61', '62', '67', '63', '64', '59', '69', '39', '83'],
      [[...Array(7).fill('0,00'), '200,00', '38,00', ...Array(49).fill('0,00'), '38,00']],
    )),
    binaryFile(syntheticLexware2025.voucher, '%PDF-1.4\n% synthetic Playwright voucher\n%%EOF'),
  ]
}

export async function materializeSyntheticLexware2025Directory() {
  const directory = path.resolve('.playwright', 'fixtures', 'synthetic-lexware-2025')
  await mkdir(directory, { recursive: true })
  await Promise.all(createSyntheticLexware2025Files().map(file =>
    writeFile(path.join(directory, file.name), file.buffer),
  ))
  return directory
}

function journalRow(value: {
  bookingNumber: string
  voucherDate: string
  postingDate: string
  journalDate: string
  documentNumber: string
  text: string
  amount: string
  debitAccount: string
  debit: string
  creditAccount: string
  credit: string
  taxAccount?: string
  tax?: string
  taxCreditAccount?: string
  taxCredit?: string
  document: string
  period: string
}) {
  return [
    value.bookingNumber, value.postingDate, value.journalDate, value.voucherDate, value.documentNumber, value.text,
    value.amount, value.debitAccount, value.debit, value.creditAccount, value.credit, value.taxAccount ?? '',
    value.tax ?? '', value.taxCreditAccount ?? '', value.taxCredit ?? '', '', '', value.document, value.period,
  ]
}

function table(headers: string[], rows: string[][]) {
  return [headers, ...rows].map(row => row.join('\t')).join('\r\n')
}

function textFile(name: string, content: string): FilePayload {
  return { name, mimeType: name.endsWith('.xml') ? 'application/xml' : 'text/plain', buffer: windows1252(content) }
}

function binaryFile(name: string, content: string): FilePayload {
  return { name, mimeType: 'application/pdf', buffer: Buffer.from(content, 'ascii') }
}

function windows1252(value: string) {
  const replacements: Record<string, number> = { '€': 0x80, 'Ü': 0xdc, 'ü': 0xfc, 'ä': 0xe4, 'ö': 0xf6, 'ß': 0xdf }
  return Buffer.from([...value].map(character => replacements[character] ?? character.charCodeAt(0)))
}
