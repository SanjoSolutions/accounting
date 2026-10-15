import { describe, expect, test } from 'vitest'
import { annualDocumentFixture } from '@/test/annualDocumentFixture'
import { annualDocumentAppropriationFixture } from '@/test/annualDocumentAppropriationFixture'
import { readRecordedAnnualAppropriation } from './annualDocumentAppropriation'
import { annualDocumentFiles, renderAnnualDocument } from './annualDocuments'

describe('approved UG appropriation presentation', () => {
  test('Given an immutable allocation contract, when printing the full accounts, then every recorded amount and the resolution reference are shown without consulting current equity values', () => {
    const { source, appropriation } = annualDocumentAppropriationFixture()
    // Current-workpaper metadata must never replace amounts in the selected package.
    source.equity.resultCents = 99999; source.equity.shareCapitalCents = 99999
    const html = renderAnnualDocument(source, 'annual')
    for (const content of ['1.000,00', '119,00', '100,00', '4,75', '14,25', 'Ausschüttung', 'Gesetzliche Rücklage vor Zuführung', 'private-appropriation-resolution']) expect(html).toContain(content)
    expect(html).not.toContain('999,99')
    expect(html).not.toContain('Der Zuführungsbetrag ist in dieser Quellversion nicht strukturiert erfasst')
    expect(html).toContain('Das Beschlussdatum ist in dieser Quellversion nicht strukturiert erfasst')
    const companion = JSON.parse(annualDocumentFiles(source, 'annual')['abschluss.json'])
    expect(companion.annual.immutablePayload).toBe(source.annual.immutablePayload)
    expect(JSON.parse(companion.annual.immutablePayload).ugResultAppropriation).toEqual(appropriation)
  })

  test('Given partial appropriation in SMALL accounts, when rendering annual and manual balance sheets, then the approved remaining-profit and comparative labels are preserved', () => {
    const { source } = annualDocumentAppropriationFixture()
    for (const mode of ['annual', 'manual'] as const) {
      const html = renderAnnualDocument(source, mode, { noteIndexes: [0, 1], policyIndexes: [0], establishedOn: '2027-03-03', confirmedCompleteAndMinimized: true })
      expect(html).toContain('Bilanzgewinn/Bilanzverlust (Vorjahr: Jahresergebnis)</td><td class="money">14,25</td><td class="money">0,00')
      expect(html).toContain('Gewinnvortrag/Verlustvortrag (im Bilanzgewinn enthalten)</td><td class="money">0,00</td><td class="money">−100,00')
    }
  })

  test.each(['MICRO', 'SMALL'] as const)('Given %s manual disclosure, when retaining selected public text, then the internal allocation table and references are excluded', size => {
    const { source } = annualDocumentAppropriationFixture(size)
    const files = annualDocumentFiles(source, 'manual', { noteIndexes: [0, 1], policyIndexes: size === 'SMALL' ? [0] : [], establishedOn: '2027-03-03', confirmedCompleteAndMinimized: true })
    for (const privateValue of ['Ergebnisverwendung und UG-Rücklage', 'Ausschüttung', 'private-appropriation-resolution', 'private-prior-loss', 'private-capital-account', 'private-reserve-posting']) expect(files['einreichung.html']).not.toContain(privateValue)
    if (size === 'MICRO') {
      expect(files['einreichung.html']).not.toContain('Gezeichnetes Kapital')
      expect(files['einreichung.html']).not.toContain('Bilanzgewinn/Bilanzverlust')
      expect(files['einreichung.html']).toContain('1.019,00')
      expect(renderAnnualDocument(source, 'annual')).toContain('Gezeichnetes Kapital')
    }
    expect(files).not.toHaveProperty('abschluss.json')
  })

  test('Given legacy records without structured amounts, when printing, then the missing-data label remains explicit', () => {
    const source = annualDocumentFixture()
    expect(readRecordedAnnualAppropriation(source.input)).toBeUndefined()
    expect(renderAnnualDocument(source, 'annual')).toContain('Der Zuführungsbetrag ist in dieser Quellversion nicht strukturiert erfasst')
  })

  test('Given missing, unsafe or inconsistent recorded data, when projecting it for printing, then it fails closed instead of inventing values', () => {
    for (const amendment of [{ reserveAllocationCents: 4.75 }, { priorLossCarryforwardCents: -1 }, { carryforwardCents: Number.MAX_SAFE_INTEGER + 1 }, { resolutionEvidenceId: '' }, { annualResultCents: 0 }, { shareCapitalCents: undefined }]) {
      const { source, appropriation } = annualDocumentAppropriationFixture()
      Object.assign(appropriation, amendment)
      expect(() => renderAnnualDocument(source, 'annual')).toThrow(/recorded|Recorded/)
    }
    const { source } = annualDocumentAppropriationFixture()
    source.input.profile.legalForm = 'GMBH'
    expect(() => readRecordedAnnualAppropriation(source.input)).toThrow(/Invalid/)
  })

  test('Given a recorded loss and hostile text, when printed, then negative cents remain exact and text cannot become markup', () => {
    const { source, appropriation } = annualDocumentAppropriationFixture()
    appropriation.annualResultCents = -200; appropriation.reserveAllocationCents = 0; appropriation.carryforwardCents = -10200
    source.input.incomeStatement = source.input.incomeStatement.map(line => line.code === 'NET_INCOME' ? { ...line, amountCents: -200 } : line)
    appropriation.resolutionEvidenceId = '<img src=x onerror=evil()>'
    source.input.balanceSheet = source.input.balanceSheet.map(line => line.code === 'B.NET_INCOME' ? { ...line, label: '<script>evil()</script>' } : line)
    const html = renderAnnualDocument(source, 'annual')
    expect(html).toContain('−2,00'); expect(html).toContain('−102,00')
    expect(html).toContain('&lt;img'); expect(html).toContain('&lt;script')
    expect(html).not.toContain('<img'); expect(html).not.toContain('<script')
  })
})
