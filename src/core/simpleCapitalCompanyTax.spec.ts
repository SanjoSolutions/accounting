import { describe, expect, it } from 'vitest'
import { calculateCapitalCompanyTax } from './simpleCapitalCompanyTax'
import { prepareCapitalCompanyDeclaration } from './simpleCapitalCompanyDeclaration'

const facts = (legalForm: 'UG' | 'GMBH', year: 2025 | 2026) => ({ legalForm, year, establishments: 1 as const, municipalityCode: '11000000', hebesatzBasisPoints: 41000, foreignIncome: false as const, groupOrConsolidation: false as const, lossCarry: false as const, specialRegime: false as const, withholdingOrCredits: false as const, payroll: false as const })
const source = { closeGenerationId: 'close-1', hgbCloseRunChecksum: 'run-hash', closingSnapshotHash: 'snapshot-hash', eBalanceArtifactId: 'ebilanz-1', eBalanceArtifactHash: 'ebilanz-hash', hgbResultCents: 100_999 }

describe('versioned narrow capital-company annual tax authority', () => {
  it.each([['UG', 2025, 'DE-UG-SIMPLE-2025.1'], ['GMBH', 2025, 'DE-CAPITAL-COMPANY-2025.1'], ['UG', 2026, 'DE-CAPITAL-COMPANY-2026.1'], ['GMBH', 2026, 'DE-CAPITAL-COMPANY-2026.1']] as const)('Given a supported %s %i close, when liabilities are previewed, then the installed versioned rules calculate exact KSt, SolZ and GewSt', (legalForm, year, ruleVersion) => {
    expect(calculateCapitalCompanyTax(100_999, 1, 0, facts(legalForm, year))).toMatchObject({ ruleVersion, taxableIncomeCents: 101_000, corporationTaxCents: 15_150, solidaritySurchargeCents: 833, tradeTaxBaseCents: 3_500, tradeTaxCents: 14_350 })
  })
  it('Given a 2026 GmbH close and authoritative 2026 adjustment, when declarations are prepared, then both datasets are bound to exact source evidence', () => {
    const result = prepareCapitalCompanyDeclaration(source, facts('GMBH', 2026), [{ id: 'adj-1', layer: 'income-tax', amountCents: 1, ruleVersion: 'KStG-2026.1', field: 'STEUERLICHES_ERGEBNIS', reason: 'Non-deductible expense', legalBasis: 'KStG §10', treatment: 'add-back', evidenceIds: ['doc-1'] }])
    expect(result).toMatchObject({ ruleVersion: 'DE-CAPITAL-COMPANY-2026.1', datasets: [{ kind: 'KST', period: '2026' }, { kind: 'GEWST', period: '2026' }] })
    expect(result.datasets[0].fields).toMatchObject({ KST_SCHULD: result.preview.corporationTaxCents })
    expect(result.datasets[1].fields).toMatchObject({ GEWST_SCHULD: result.preview.tradeTaxCents })
    expect(result.datasets[0].drilldown.STEUERLICHES_ERGEBNIS).toEqual(expect.arrayContaining(['close-1', 'adj-1']))
  })
  it('Given an unsupported period, fiscal fact or multiple establishments, when preparation is attempted, then it fails closed', () => {
    expect(() => calculateCapitalCompanyTax(1, 0, 0, { ...facts('GMBH', 2026), year: 2027 } as never)).toThrow(/2025\/2026/)
    expect(() => calculateCapitalCompanyTax(1, 0, 0, { ...facts('GMBH', 2026), establishments: 2 } as never)).toThrow(/single-municipality/)
    expect(() => calculateCapitalCompanyTax(1, 0, 0, { ...facts('UG', 2025), foreignIncome: true } as never)).toThrow(/does not support/)
  })
})
