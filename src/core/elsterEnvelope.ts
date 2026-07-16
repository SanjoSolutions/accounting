import { AccountingValidationError } from './doubleEntry'

export interface ElsterEBalanceMetadata {
  manufacturerId: string
  dataSupplier: string
  clientVersion: string
  ticket: string
  taxNumber: string
  balanceSheetDate: string
  testMarker?: string
}

/** Creates the ELSTER-v11 transport document expected by ERiC for Bilanz_6.9. */
export function createElsterEBalanceEnvelope(
  xbrl: string,
  metadata: ElsterEBalanceMetadata,
): string {
  const issues: string[] = []
  const manufacturerId = requireText(metadata?.manufacturerId, 'Die Hersteller-ID', issues)
  const dataSupplier = requireText(metadata?.dataSupplier, 'Der Datenlieferant', issues)
  const clientVersion = requireText(metadata?.clientVersion, 'Die Client-Version', issues)
  const ticket = requireText(metadata?.ticket, 'Das Nutzdaten-Ticket', issues)
  const taxNumber = requireText(metadata?.taxNumber, 'Die ELSTER-Steuernummer', issues)
  const balanceSheetDate = requireText(metadata?.balanceSheetDate, 'Der Bilanzstichtag', issues)
  const testMarker = metadata?.testMarker

  if (manufacturerId && !/^\d+$/.test(manufacturerId)) {
    issues.push('Die Hersteller-ID darf nur Ziffern enthalten.')
  }
  if (taxNumber && !/^\d{13}$/.test(taxNumber)) {
    issues.push('Die ELSTER-Steuernummer muss aus genau 13 Ziffern bestehen.')
  }
  if (balanceSheetDate && !isCalendarDate(balanceSheetDate)) {
    issues.push('Der Bilanzstichtag muss ein gültiges Datum im Format JJJJ-MM-TT sein.')
  }
  if (testMarker !== undefined && (typeof testMarker !== 'string' || !/^\d+$/.test(testMarker))) {
    issues.push('Der Testmerker darf nur Ziffern enthalten.')
  }
  if (issues.length) throw new AccountingValidationError(issues)

  const nestedXbrl = normalizeXbrl(xbrl)
  const escapedSupplier = escapeXml(dataSupplier)
  const escapedClientVersion = escapeXml(clientVersion)
  const compactDate = balanceSheetDate.replaceAll('-', '')

  return `<?xml version="1.0" encoding="UTF-8"?>
<Elster xmlns="http://www.elster.de/elsterxml/schema/v11">
  <TransferHeader version="11">
    <Verfahren>ElsterBilanz</Verfahren>
    <DatenArt>Bilanz</DatenArt>
    <Vorgang>send-Auth</Vorgang>
${testMarker === undefined ? '' : `    <Testmerker>${testMarker}</Testmerker>\n`}    <HerstellerID>${manufacturerId}</HerstellerID>
    <DatenLieferant>${escapedSupplier}</DatenLieferant>
    <Datei>
      <Verschluesselung>CMSEncryptedData</Verschluesselung>
      <Kompression>GZIP</Kompression>
      <TransportSchluessel/>
    </Datei>
    <VersionClient>${escapedClientVersion}</VersionClient>
  </TransferHeader>
  <DatenTeil>
    <Nutzdatenblock>
      <NutzdatenHeader version="11">
        <NutzdatenTicket>${escapeXml(ticket)}</NutzdatenTicket>
        <Empfaenger id="F">${taxNumber.slice(0, 4)}</Empfaenger>
        <Hersteller>
          <ProduktName>Accounting</ProduktName>
          <ProduktVersion>${escapedClientVersion}</ProduktVersion>
        </Hersteller>
        <DatenLieferant>${escapedSupplier}</DatenLieferant>
      </NutzdatenHeader>
      <Nutzdaten>
        <ebilanz:EBilanz version="000002" xmlns:ebilanz="http://rzf.fin-nrw.de/RMS/EBilanz/2016/XMLSchema">
          <ebilanz:stichtag>${compactDate}</ebilanz:stichtag>
${indent(nestedXbrl, 10)}
        </ebilanz:EBilanz>
      </Nutzdaten>
    </Nutzdatenblock>
  </DatenTeil>
</Elster>`
}

function requireText(value: unknown, label: string, issues: string[]): string {
  if (typeof value !== 'string' || !value.trim()) {
    issues.push(`${label} ist erforderlich.`)
    return ''
  }
  return value
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function normalizeXbrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AccountingValidationError(['Die XBRL-Instanz ist erforderlich.'])
  }
  assertXmlCharacters(value, 'Die XBRL-Instanz')
  const withoutDeclaration = value.replace(/^\uFEFF?\s*<\?xml\s[^?]*(?:\?(?!>)[^?]*)*\?>\s*/i, '')
  if (/<\?xml(?:\s|\?>)/i.test(withoutDeclaration)) {
    throw new AccountingValidationError(['Die XBRL-Instanz enthält eine unerwartete XML-Deklaration.'])
  }
  if (/<!DOCTYPE/i.test(withoutDeclaration)) {
    throw new AccountingValidationError(['Die XBRL-Instanz darf keine Dokumenttyp-Deklaration enthalten.'])
  }
  if (!/^<xbrli:xbrl(?:\s|>)/.test(withoutDeclaration)) {
    throw new AccountingValidationError(['Die XBRL-Instanz muss mit dem Element xbrli:xbrl beginnen.'])
  }
  return withoutDeclaration.trim()
}

function escapeXml(value: string): string {
  assertXmlCharacters(value, 'ELSTER-Metadaten')
  return value.replace(/[<>&"']/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[character]!)
}

function assertXmlCharacters(value: string, label: string): void {
  for (const character of value) {
    const point = character.codePointAt(0)!
    const allowed = point === 0x9 || point === 0xA || point === 0xD ||
      (point >= 0x20 && point <= 0xD7FF) || (point >= 0xE000 && point <= 0xFFFD) ||
      (point >= 0x10000 && point <= 0x10FFFF)
    if (!allowed) throw new AccountingValidationError([`${label} enthält ein in XML nicht zulässiges Zeichen.`])
  }
}

function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value.split(/\r?\n/).map(line => `${prefix}${line}`).join('\n')
}
