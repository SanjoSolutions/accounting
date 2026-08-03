import { calculateSimpleUg2025Tax, SIMPLE_UG_2025_RULE_VERSION, type SimpleUg2025Facts, type SimpleUg2025Preview } from './simpleUg2025Tax'

export type SimpleUg2025Adjustment = Readonly<{
  id: string
  layer: 'income-tax' | 'trade-tax'
  amountCents: number
  ruleVersion: string
  field: 'STEUERLICHES_ERGEBNIS' | 'GEWERBEERTRAG'
  reason: string
  legalBasis: string
  treatment: 'add-back' | 'deduction'
  evidenceIds: readonly string[]
}>

export type SimpleUg2025DeclarationSource = Readonly<{
  closeGenerationId: string
  hgbCloseRunChecksum: string
  closingSnapshotHash: string
  eBalanceArtifactId: string
  eBalanceArtifactHash: string
  hgbResultCents: number
}>

export type SimpleUg2025DeclarationPreparation = Readonly<{
  ruleVersion: typeof SIMPLE_UG_2025_RULE_VERSION
  authority: 'NON_BINDING_PREVIEW'
  notice: string
  preview: SimpleUg2025Preview
  datasets: readonly [
    { kind: 'KST'; period: '2025'; fields: Readonly<Record<string, number>>; drilldown: Readonly<Record<string, readonly string[]>> },
    { kind: 'GEWST'; period: '2025'; fields: Readonly<Record<string, number | string>>; drilldown: Readonly<Record<string, readonly string[]>> },
  ]
}>

const notice = 'Non-binding local preview only. The Finanzamt assessment is authoritative.'

export function prepareSimpleUg2025Declaration(source: SimpleUg2025DeclarationSource, facts: SimpleUg2025Facts, adjustments: readonly SimpleUg2025Adjustment[]): SimpleUg2025DeclarationPreparation {
  for (const [label, value] of Object.entries({ closeGenerationId: source.closeGenerationId, hgbCloseRunChecksum: source.hgbCloseRunChecksum, closingSnapshotHash: source.closingSnapshotHash, eBalanceArtifactId: source.eBalanceArtifactId, eBalanceArtifactHash: source.eBalanceArtifactHash })) if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  if (!Number.isSafeInteger(source.hgbResultCents)) throw new Error('HGB result must be safe integer cents.')
  if (new Set(adjustments.map(item => item.id)).size !== adjustments.length) throw new Error('Adjustment IDs must be unique.')
  for (const adjustment of adjustments) {
    const expected = adjustment.layer === 'income-tax'
      ? { version: 'KStG-2025.1', field: 'STEUERLICHES_ERGEBNIS' }
      : { version: 'GewStG-2025.1', field: 'GEWERBEERTRAG' }
    if (!adjustment.id.trim() || !Number.isSafeInteger(adjustment.amountCents) || adjustment.ruleVersion !== expected.version || adjustment.field !== expected.field || !adjustment.reason.trim() || !adjustment.legalBasis.trim() || !['add-back', 'deduction'].includes(adjustment.treatment) || !adjustment.evidenceIds.length || adjustment.evidenceIds.some(id => !id.trim())) throw new Error(`Adjustment ${adjustment.id || '(blank)'} is not valid for the narrow 2025 UG rules.`)
  }
  const incomeAdjustments = adjustments.filter(item => item.layer === 'income-tax')
  const tradeAdjustments = adjustments.filter(item => item.layer === 'trade-tax')
  const sum = (items: readonly SimpleUg2025Adjustment[]) => items.reduce((total, item) => { const next = total + item.amountCents; if (!Number.isSafeInteger(next)) throw new Error('Adjustment total exceeds safe integer cents.'); return next }, 0)
  const preview = calculateSimpleUg2025Tax(source.hgbResultCents, sum(incomeAdjustments), sum(tradeAdjustments), facts)
  const baseEvidence = [source.closeGenerationId, source.hgbCloseRunChecksum, source.closingSnapshotHash, source.eBalanceArtifactId, source.eBalanceArtifactHash]
  const incomeEvidence = [...baseEvidence, ...incomeAdjustments.map(item => item.id)]
  const tradeEvidence = [...incomeEvidence, ...tradeAdjustments.map(item => item.id)]
  return Object.freeze({
    ruleVersion: SIMPLE_UG_2025_RULE_VERSION,
    authority: 'NON_BINDING_PREVIEW' as const,
    notice,
    preview,
    datasets: Object.freeze([
      Object.freeze({ kind: 'KST' as const, period: '2025' as const, fields: Object.freeze({ STEUERLICHES_ERGEBNIS: preview.taxableIncomeCents }), drilldown: Object.freeze({ STEUERLICHES_ERGEBNIS: Object.freeze(incomeEvidence) }) }),
      Object.freeze({ kind: 'GEWST' as const, period: '2025' as const, fields: Object.freeze({ GEWERBEERTRAG: preview.tradeIncomeCents, GEMEINDE: facts.municipalityCode, HEBESATZ_BP: facts.hebesatzBasisPoints }), drilldown: Object.freeze({ GEWERBEERTRAG: Object.freeze(tradeEvidence) }) }),
    ]) as SimpleUg2025DeclarationPreparation['datasets'],
  })
}
