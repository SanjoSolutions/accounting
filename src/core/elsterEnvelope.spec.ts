import { describe, expect, it } from 'vitest'
import { AccountingValidationError } from './doubleEntry'
import { createElsterEBalanceEnvelope, type ElsterEBalanceMetadata } from './elsterEnvelope'

const metadata: ElsterEBalanceMetadata = {
  manufacturerId: '74931',
  dataSupplier: 'Muster GmbH',
  clientVersion: '1.2.3',
  ticket: 'bilanz-2026-0001',
  taxNumber: '1234567890123',
  balanceSheetDate: '2026-12-31',
}

const xbrl = `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"><xbrli:unit id="EUR" /></xbrli:xbrl>`

describe('ELSTER E-Bilanz envelope', () => {
  it('creates the official ELSTER-v11 Bilanz wrapper and recipient', () => {
    const xml = createElsterEBalanceEnvelope(xbrl, metadata)

    expect(xml).toContain('<Elster xmlns="http://www.elster.de/elsterxml/schema/v11">')
    expect(xml).toContain('<Verfahren>ElsterBilanz</Verfahren>')
    expect(xml).toContain('<DatenArt>Bilanz</DatenArt>')
    expect(xml).toContain('<Vorgang>send-Auth</Vorgang>')
    expect(xml).toContain('<HerstellerID>74931</HerstellerID>')
    expect(xml).toContain('<NutzdatenTicket>bilanz-2026-0001</NutzdatenTicket>')
    expect(xml).toContain('<Empfaenger id="F">1234</Empfaenger>')
    expect(xml).toContain('<ebilanz:EBilanz version="000002"')
    expect(xml).toContain('<ebilanz:stichtag>20261231</ebilanz:stichtag>')
    expect(xml).toContain('<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance">')
  })

  it('escapes all user-controlled metadata', () => {
    const xml = createElsterEBalanceEnvelope(xbrl, {
      ...metadata,
      dataSupplier: `A & B <GmbH> "Nord" 'Süd'`,
      clientVersion: 'v1 & beta',
      ticket: 'A&B<1>',
    })

    expect(xml).toContain('A &amp; B &lt;GmbH&gt; &quot;Nord&quot; &apos;Süd&apos;')
    expect(xml).toContain('<VersionClient>v1 &amp; beta</VersionClient>')
    expect(xml).toContain('<NutzdatenTicket>A&amp;B&lt;1&gt;</NutzdatenTicket>')
  })

  it('adds a numeric test marker only when configured', () => {
    expect(createElsterEBalanceEnvelope(xbrl, { ...metadata, testMarker: '700000004' }))
      .toContain('<Testmerker>700000004</Testmerker>')
    expect(createElsterEBalanceEnvelope(xbrl, metadata)).not.toContain('<Testmerker>')
  })

  it.each([
    [{ manufacturerId: '74A31' }, 'Hersteller-ID darf nur Ziffern'],
    [{ taxNumber: '123' }, 'genau 13 Ziffern'],
    [{ balanceSheetDate: '2026-02-30' }, 'gültiges Datum'],
    [{ testMarker: 'test' }, 'Testmerker darf nur Ziffern'],
    [{ dataSupplier: '' }, 'Datenlieferant ist erforderlich'],
  ])('rejects invalid metadata %j', (change, message) => {
    expect(() => createElsterEBalanceEnvelope(xbrl, { ...metadata, ...change }))
      .toThrow(message)
  })

  it('reports validation problems as AccountingValidationError', () => {
    expect(() => createElsterEBalanceEnvelope('', metadata)).toThrow(AccountingValidationError)
    expect(() => createElsterEBalanceEnvelope('<!DOCTYPE x><xbrli:xbrl />', metadata))
      .toThrow('Dokumenttyp-Deklaration')
  })

  it('removes the nested XBRL declaration without removing the envelope declaration', () => {
    const xml = createElsterEBalanceEnvelope(xbrl, metadata)

    expect(xml.match(/<\?xml/g)).toHaveLength(1)
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  })
})
