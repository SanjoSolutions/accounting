import { describe, expect, it } from 'vitest'
import { prepareSimpleUg2025Declaration } from './simpleUg2025Declaration'

const source = { closeGenerationId: 'generation-1', hgbCloseRunChecksum: 'close-checksum', closingSnapshotHash: 'snapshot-hash', eBalanceArtifactId: 'ebilanz-1', eBalanceArtifactHash: 'ebilanz-hash', hgbResultCents: 10_000_000 }
const facts = { legalForm: 'UG' as const, year: 2025 as const, establishments: 1 as const, municipalityCode: '11000000', hebesatzBasisPoints: 41000, foreignIncome: false as const, groupOrConsolidation: false as const, lossCarry: false as const, specialRegime: false as const, withholdingOrCredits: false as const, payroll: false as const }

describe('prepareSimpleUg2025Declaration', () => {
  it('derives deterministic KSt, SolZ and GewSt datasets from one exact locked-close source', () => {
    const result = prepareSimpleUg2025Declaration(source, facts, [{ id: 'adj-1', layer: 'income-tax', amountCents: 100_000, ruleVersion: 'KStG-2025.1', field: 'STEUERLICHES_ERGEBNIS', reason: 'Non-deductible expense', legalBasis: 'KStG §10', treatment: 'add-back', evidenceIds: ['document-1'] }])
    expect(result).toMatchObject({ authority: 'NON_BINDING_PREVIEW', ruleVersion: 'DE-UG-SIMPLE-2025.1', preview: { taxableIncomeCents: 10_100_000, corporationTaxCents: 1_515_000, solidaritySurchargeCents: 83_325 } })
    expect(result.datasets[0].fields).toEqual({ STEUERLICHES_ERGEBNIS: 10_100_000 })
    expect(result.datasets[1].fields).not.toHaveProperty('GEWST_SCHULD')
    expect(result.datasets[1].fields).toMatchObject({ GEMEINDE: '11000000', HEBESATZ_BP: 41000 })
    expect(result.datasets[0].drilldown.STEUERLICHES_ERGEBNIS).toContain('generation-1')
  })

  it('fails closed for an unsupported fact or non-2025 adjustment rule', () => {
    expect(() => prepareSimpleUg2025Declaration(source, { ...facts, foreignIncome: true } as unknown as typeof facts, [])).toThrow(/does not support/)
    expect(() => prepareSimpleUg2025Declaration(source, facts, [{ id: 'adj', layer: 'income-tax', amountCents: 1, ruleVersion: 'KStG-2026.1', field: 'STEUERLICHES_ERGEBNIS', reason: 'Unsupported', legalBasis: 'KStG §10', treatment: 'add-back', evidenceIds: ['doc'] }])).toThrow(/not valid/)
  })
})
