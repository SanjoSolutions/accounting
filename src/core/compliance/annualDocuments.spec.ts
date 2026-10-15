import { describe, expect, test } from 'vitest'
import { annualDocumentFixture } from '@/test/annualDocumentFixture'
import { annualDocumentFiles, euroCents, readAnnualDocumentInput, renderAnnualDocument, selectDisclosure } from './annualDocuments'

describe('immutable printable annual accounts', () => {
  test('Given an approved snapshot, when rendered, then identity, both periods, statements, notes and recorded approval evidence are readable', () => {
    const source = annualDocumentFixture()
    const html = renderAnnualDocument(source, 'annual')
    for (const content of ['Druck &amp; Daten', '01.01.2026', '31.12.2025', 'Bilanz', 'Gewinn- und Verlustrechnung', 'Anhang', '1.000,00', '900,00', '300,00', 'private-reserve', 'private-resolution', 'reviewer-a', 'Geschäftsführer Test', 'keine Aussage über eine qualifizierte elektronische Signatur']) expect(html).toContain(content)
    expect(JSON.parse(annualDocumentFiles(source, 'annual')['abschluss.json']).annual.immutablePayload).toBe(source.annual.immutablePayload)
    expect(euroCents(-123456789)).toBe('−1.234.567,89')
    expect(() => euroCents(Number.MAX_SAFE_INTEGER + 1)).toThrow()
  })
  test('Given corrupt or unreconciled stored statements, when read, then no document is produced', () => {
    const { annual } = annualDocumentFixture()
    expect(readAnnualDocumentInput(annual).fiscalYear).toBe(2026)
    expect(() => readAnnualDocumentInput({ ...annual, checksum: 'bad' })).toThrow()
    const payload = JSON.parse(annual.immutablePayload); payload.balanceSheet[0].amountCents++
    expect(() => readAnnualDocumentInput({ ...annual, immutablePayload: JSON.stringify(payload) })).toThrow(/balance|invalid/i)
  })
  test('Given hostile text in every printable section, when rendered, then it remains text with no active HTML', () => {
    const source = annualDocumentFixture(); const attack = '<script>alert("x")</script><img src=x onerror=evil()>'
    source.input.profile.legalName = attack; source.input.notes = [attack]; source.input.policies = [attack]; source.approvedBy = attack; source.close.signatures[0].representativeId = attack; source.close.resolutionId = attack
    const html = renderAnnualDocument(source, 'annual')
    expect(html).not.toContain('<script'); expect(html).not.toContain('<img'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&quot;x&quot;')
  })
})

describe('minimized manual disclosure', () => {
  test.each(['MICRO', 'SMALL'] as const)('Given a detailed internal %s balance sheet, when preparing manual disclosure, then extra breakdowns are omitted and approved totals stay unchanged', size => {
    const source = annualDocumentFixture(size)
    source.input.balanceSheet = source.input.balanceSheet.map(line => line.code === 'A.GOODWILL' ? { ...line, label: 'Internal additional breakdown' } : line)
    expect(renderAnnualDocument(source, 'annual')).toContain('Internal additional breakdown')
    const html = renderAnnualDocument(source, 'manual', { noteIndexes: [0, 1], policyIndexes: size === 'SMALL' ? [0] : [], establishedOn: '2027-03-03', confirmedCompleteAndMinimized: true })
    expect(html).not.toContain('Internal additional breakdown')
    const total = source.input.balanceSheet.find(line => line.code === 'A.ASSETS')!
    expect(html).toContain(`Summe Aktiva</td><td class="money">${euroCents(total.amountCents)}</td><td class="money">${euroCents(total.comparativeCents)}`)
    if (size === 'MICRO') expect(html).not.toContain('Gezeichnetes Kapital')
  })
  test.each(['MICRO', 'SMALL'] as const)('Given supported %s facts and reviewed selection, when exported, then only the balance sheet and selected disclosures leave the internal report', size => {
    const source = annualDocumentFixture(size)
    const files = annualDocumentFiles(source, 'manual', { noteIndexes: [0, 1], policyIndexes: size === 'SMALL' ? [0] : [], establishedOn: '2027-03-03', confirmedCompleteAndMinimized: true })
    const html = files['einreichung.html']
    expect(html).toContain(size === 'MICRO' ? 'Angaben unter der Bilanz' : 'Anhang')
    expect(html).toContain('Haftungsverhältnisse'); expect(html).toContain('31.12.2025')
    for (const secret of ['PRIVATE', 'Geheimkunde', 'private-signature', 'private-resolution', 'private-reserve', 'NET_INCOME', 'tenant-a', 'accountIds', 'Gewinn- und Verlustrechnung', 'reviewer-a']) expect(html).not.toContain(secret)
    expect(Object.keys(files)).toEqual(['einreichung.html', 'ANLEITUNG.txt'])
    expect(files['ANLEITUNG.txt']).toContain('KEINE Einreichungsformate'); expect(files['ANLEITUNG.txt']).toContain('PDF-/Office-Konvertierung'); expect(files['ANLEITUNG.txt']).toContain('kein authentifizierter Gateway-Empfang')
  })
  test('Given missing attestation, out-of-range selections or placeholder notes, when preparing disclosure, then it fails closed', () => {
    const source = annualDocumentFixture('MICRO')
    const selection = { noteIndexes: [0], policyIndexes: [], establishedOn: '2027-03-03', confirmedCompleteAndMinimized: true as const }
    expect(() => selectDisclosure(source, { ...selection, confirmedCompleteAndMinimized: false as never })).toThrow(/Confirm/)
    expect(() => selectDisclosure(source, { ...selection, noteIndexes: [999] })).toThrow(/invalid/)
    expect(() => selectDisclosure(source, { ...selection, noteIndexes: [] })).toThrow(/Actual/)
    expect(() => selectDisclosure(source, { ...selection, establishedOn: '2027-02-30' })).toThrow(/establishment date/)
    expect(() => selectDisclosure(source, { ...selection, establishedOn: '2025-01-01' })).toThrow(/establishment date/)
    expect(() => selectDisclosure(source, { ...selection, policyIndexes: [0] })).toThrow(/excludes/)
    source.input.notes = ['Anhangangaben werden aufgrund der dokumentierten Kleinstkapitalgesellschaft-Erleichterung unter der Bilanz ausgewiesen.']
    expect(() => selectDisclosure(source, selection)).toThrow(/placeholder/)
    source.close.notesRequired = true
    expect(() => selectDisclosure(source, selection)).toThrow(/exemption/)
  })
})
