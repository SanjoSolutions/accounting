import { createHash } from 'node:crypto'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { canonicalJson } from '@/core/compliance/auditExport'
import type { LedgerBalance } from '@/core/doubleEntry'

export const EXTERNAL_ADAPTER_VERSION = 'myebilanz-basis-2026-v1'
export type ExternalEBalanceSource = {
  fiscalYearId: string; year: number; startsAt: string; endsAt: string
  closeGenerationId: string; sourceFingerprint: string; taxonomyVersion: string
  accounts: LedgerBalance[]
  /** Complete authoritative dataset, including reconciliation and asset disclosures. */
  dataset: unknown
  /** Official instance/package from the shared serializer, never internal evidence XML. */
  xbrl: string; xbrlPackage: Uint8Array
}
export const hashBytes = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const json = (value: unknown) => strToU8(canonicalJson(value) + '\n')
const money = (cents: number) => `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`
const csv = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`
const row = (values: Array<string | number>) => values.map(csv).join(';') + '\r\n'

export function createAccountExports(accounts: readonly LedgerBalance[]) {
  const sorted = [...accounts].sort((a, b) => a.number - b.number)
  if (!sorted.length) throw new Error('Keine Kontensalden vorhanden.')
  const numbers = new Set<number>(); const ids = new Set<string>()
  let debit = 0; let credit = 0
  const mapping = new Map<string, number[]>()
  for (const account of sorted) {
    if (!Number.isSafeInteger(account.number) || account.number <= 0 || numbers.has(account.number) || ids.has(account.accountId)) throw new Error('Kontonummern müssen eindeutig und positiv sein; Konto 0 ist in myebilanz reserviert.')
    if (![account.debitCents, account.creditCents, account.balanceCents].every(Number.isSafeInteger) || account.debitCents < 0 || account.creditCents < 0 || account.balanceCents !== account.debitCents - account.creditCents) throw new Error('Kontensaldo und Soll/Haben stimmen nicht überein.')
    if (!account.name.trim() || /[\u0000-\u001f\u007f]/.test(account.name)) throw new Error('Kontobezeichnungen müssen einzeilig und ohne Steuerzeichen sein.')
    if (account.eBilanzPosition && !/^(bs|is)\.[A-Za-z0-9_.]+$/.test(account.eBilanzPosition)) throw new Error('Die Kontenzuordnung wird vom BASIS-Mappingadapter nicht unterstützt.')
    if (!account.eBilanzPosition && account.balanceCents !== 0) throw new Error('Jeder Nichtnullsaldo benötigt eine Taxonomiezuordnung.')
    numbers.add(account.number); ids.add(account.accountId)
    debit += account.debitCents; credit += account.creditCents
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit)) throw new Error('Kontensummen überschreiten den sicheren Centbereich.')
    if (account.eBilanzPosition) mapping.set(account.eBilanzPosition, [...(mapping.get(account.eBilanzPosition) ?? []), account.number])
  }
  if (debit !== credit) throw new Error('Die Summen- und Saldenliste ist nicht ausgeglichen.')
  // myebilanz's parser explicitly does not implement escaped double quotes.
  // Preserve the original names in the portable export; never silently rename them.
  const receiverLimitations = sorted.filter(account => account.name.includes('"')).map(account => `Konto ${account.number}: myebilanz unterstützt keine doppelten Anführungszeichen in Kontobezeichnungen. Portable SuSa und manuelle Alternative verwenden.`)
  const providerCsv = receiverLimitations.length ? null : sorted.map(account => row([account.number, money(account.balanceCents), account.name])).join('')
  const portableCsv = row(['Konto', 'Bezeichnung', 'Soll EUR', 'Haben EUR', 'Saldo Soll-Haben EUR', 'Taxonomieposition'])
    + sorted.map(account => row([account.number, account.name, money(account.debitCents), money(account.creditCents), money(account.balanceCents), account.eBilanzPosition ?? ''])).join('')
  const mappingText = [...mapping].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([concept, accounts]) => `de-gaap-ci:${concept}=${accounts.join(',')}`).join('\r\n')
  return { providerCsv, portableCsv, mappingText, receiverLimitations, reconciliation: { accountCount: sorted.length, debitCents: debit, creditCents: credit, differenceCents: debit - credit, zeroBalanceAccounts: sorted.filter(a => a.balanceCents === 0).length } }
}

export const handoffInstructions = `Externe E-Bilanz: myebilanz BASIS

1. ZIP unverändert aufbewahren; SHA-256 und manifest.json identifizieren diese Version. Nur Kopien bearbeiten. susa.csv und abstimmung.json prüfen.
2. myebilanz aktualisieren und eine neue BASIS-Konfiguration für das Geschäftsjahr erstellen. myebilanz-mapping.ini.template ist eine ergänzungsbedürftige Zuordnungsvorlage, keine sendefertige INI. Die angegebenen Abschnitte in der eigenen INI übernehmen, den absoluten CSV-Pfad setzen. INI als ANSI/Windows-1252 speichern. Zugangsdaten ausschließlich im Zielprogramm eingeben.
3. Stammdaten, Berichtsart und Taxonomie aus datengrundlage.json prüfen. Jahresergebnis (myebilanz-Pseudokonto 0), Eigenkapital/UG-Rücklage, Vorjahr, Betriebsvermögensvergleich, steuerliche Überleitung und Anlagenspiegel im Zielprogramm vollständig abgleichen. Die CSV enthält Buchsalden, keine automatisch eingerechneten Steuerkorrekturen. Keine Position aus der Datengrundlage weglassen.
4. In myebilanz lokal validieren und die dort erzeugte Darstellung mit Datengrundlage und XBRL vergleichen. Diese Anwendung hat keinen Import in myebilanz ausgeführt und bestätigt keine Empfängerkompatibilität. Die XBRL-ZIP ist ein separates Exportformat; myebilanz BASIS importiert sie nicht. PLUS importiert nur Bilanz/GuV aus XBRL, keine vollständige Übernahme aller Berichtsteile.
5. Erst nach vollständiger Prüfung außerhalb dieser Anwendung übermitteln. Validierungsbericht, tatsächlich übermittelte Datei und Übertragungsprotokoll aufbewahren. Hier den passenden Nachweis ausdrücklich der Exportversion zuordnen. Änderungen im Zielprogramm dokumentieren; dessen Sendebytes unterscheiden sich von diesem Export. Hochgeladene Belege sind Benutzerangaben, keine authentifizierte amtliche Annahme.

Grenzen: Die Vorlage überträgt Kontenzuordnungen, nicht automatisch sämtliche GCD-, Überleitungs- oder Anlagenfelder. Für Fakten, die myebilanz nicht unterstützt, eBilanz-Online als manuelle Alternative prüfen: neue Periode anlegen, vollständige Daten anhand der Datengrundlage erfassen und vor Übertragung validieren. Auch dort wird kein ZIP-Import zugesichert. Preis laut Anbieter am 13.10.2026: 39 EUR netto je Übertragung, kein Abo. eBilanz+ nennt 35 EUR netto je Abgabe. Registrierung, Kauf und Übermittlung erfolgen durch den Benutzer.

CSV: UTF-8 ohne BOM, Semikolon, CRLF, Dezimalpunkt, genau zwei Nachkommastellen, keine Tausendertrenner. Soll positiv, Haben negativ; Nullsaldo 0.00 bleibt enthalten. Alle Felder sind in Anführungszeichen. In der portablen SuSa werden innere Anführungszeichen verdoppelt. myebilanz unterstützt dieses Escaping nicht: Bei solchen Kontobezeichnungen fehlen die myebilanz-Dateien bewusst, und das Manifest nennt die betroffenen Konten. Die portable SuSa erhält alle Bezeichnungen unverändert. Ungewöhnliche Sonderzeichen im Zielprogramm prüfen. Tabellenprogramme nur über Textimport verwenden, damit Bezeichnungen nicht als Formeln interpretiert werden.

Quellen (geprüft 13.10.2026):
https://www.myebilanz.de/myebilanz.pdf (Version 2.3.1.x, Abschnitte 3.2.2, 15.5, 15.6)
https://www.myebilanz.de/050-funktionen.php
https://www.myebilanz.de/075-plus-funktionen.php
https://www.ebilanzonline.de/preismodell/
https://ebilanzplus.de/kosten
`

export function createExternalPackage(source: ExternalEBalanceSource, version: number) {
  if (source.year !== 2026 || source.taxonomyVersion !== '6.9') throw new Error('Dieser dokumentierte myebilanz-Adapter unterstützt 2026 mit Taxonomie 6.9.')
  if (![source.startsAt, source.endsAt].every(date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) && new Date(date).toISOString().slice(0, 10) === date) || source.startsAt > source.endsAt) throw new Error('Ungültiger Berichtszeitraum.')
  const exports = createAccountExports(source.accounts)
  // ASCII is byte-identical in Windows-1252; never place user strings in INI syntax.
  const template = `; MAPPING TEMPLATE ONLY - complete master data and report sections in myebilanz.\r\n; Set filename to the absolute path of myebilanz-salden.csv.\r\n[csv]\r\nfilename=REPLACE_WITH_ABSOLUTE_PATH_TO_CSV\r\ndelimiter=;\r\nfieldKto=1\r\nfieldValue=2\r\nfieldName=3\r\nfieldValueDebit=0\r\nfieldValueCredit=0\r\nfieldSH=0\r\nfieldXBRL=0\r\n\r\n[period]\r\nfiscalYearBegin=${source.startsAt}\r\nfiscalYearEnd=${source.endsAt}\r\nbalSheetClosingDate=${source.endsAt}\r\n\r\n[xbrl]\r\n${exports.mappingText}\r\n; Review placement of myebilanz pseudo-account 0 (annual result).\r\n`
  const files: Record<string, Uint8Array> = {
    ...(exports.providerCsv !== null ? { 'myebilanz-salden.csv': strToU8(exports.providerCsv), 'myebilanz-mapping.ini.template': strToU8(template) } : {}),
    'susa.csv': strToU8(exports.portableCsv), 'abstimmung.json': json(exports.reconciliation),
    'datengrundlage.json': json(source.dataset), 'e-bilanz.xbrl': strToU8(source.xbrl),
    'xbrl-mit-taxonomie.zip': source.xbrlPackage, 'ANLEITUNG.txt': strToU8(handoffInstructions),
  }
  const manifest = {
    format: 'accounting-external-e-bilanz/v1', adapterVersion: EXTERNAL_ADAPTER_VERSION, version,
    fiscalYearId: source.fiscalYearId, year: source.year, startsAt: source.startsAt, endsAt: source.endsAt,
    closeGenerationId: source.closeGenerationId, sourceFingerprint: source.sourceFingerprint, taxonomyVersion: source.taxonomyVersion,
    exportStatus: 'PREPARED_FOR_EXTERNAL_REVIEW', receiverStatus: 'NOT_VALIDATED', transmissionStatus: 'NOT_RECORDED', acceptanceStatus: 'NOT_AUTHENTICATED',
    receiverContract: 'DOCUMENTED_CSV_AND_MAPPING_TEMPLATE_NOT_END_TO_END_TESTED',
    receiverLimitations: exports.receiverLimitations,
    receiverMode: exports.providerCsv === null ? 'PORTABLE_MANUAL_ALTERNATIVE' : 'MYEBILANZ_BASIS_TEMPLATE',
    reconciliation: exports.reconciliation,
    manualCompletionRequired: ['GCD', 'ANNUAL_RESULT_AND_EQUITY', 'PRIOR_YEAR', 'BVV', 'TAX_RECONCILIATION', 'ASSET_DISCLOSURES'],
    files: Object.entries(files).map(([name, bytes]) => ({ name, bytes: bytes.byteLength, sha256: hashBytes(bytes) })),
  }
  files['manifest.json'] = json(manifest)
  files['SHA256SUMS.txt'] = strToU8(Object.entries(files).map(([name, bytes]) => `${hashBytes(bytes)}  ${name}`).join('\n') + '\n')
  // Stable ZIP metadata makes repeated construction of an identical version reproducible.
  const archive = zipSync(Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, [bytes, { mtime: new Date('2000-01-01T00:00:00Z') }]])), { level: 6 })
  return { archive, manifest }
}

export type ExternalManifest = ReturnType<typeof createExternalPackage>['manifest']
export function readExternalPackage(bytes: Uint8Array, expectedHash: string) {
  if (hashBytes(bytes) !== expectedHash) throw new Error('Die gespeicherten Exportbytes haben sich verändert.')
  const files = unzipSync(bytes)
  const manifest = JSON.parse(strFromU8(files['manifest.json'])) as ExternalManifest
  if (manifest.format !== 'accounting-external-e-bilanz/v1' || !Array.isArray(manifest.files)) throw new Error('Ungültiges Exportmanifest.')
  for (const file of manifest.files) if (!files[file.name] || files[file.name].byteLength !== file.bytes || hashBytes(files[file.name]) !== file.sha256) throw new Error('Die Paketdateien stimmen nicht mit dem Manifest überein.')
  return { files, manifest }
}
