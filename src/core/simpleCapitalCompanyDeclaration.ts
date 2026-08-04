import { CAPITAL_COMPANY_RULES, calculateCapitalCompanyTax, capitalCompanyRuleVersion, type CapitalCompanyFacts, type CapitalCompanyPreview } from './simpleCapitalCompanyTax'

export type CapitalCompanyAdjustment = Readonly<{ id: string; layer: 'income-tax' | 'trade-tax'; amountCents: number; ruleVersion: string; field: 'STEUERLICHES_ERGEBNIS' | 'GEWERBEERTRAG'; reason: string; legalBasis: string; treatment: 'add-back' | 'deduction'; evidenceIds: readonly string[] }>
export type CapitalCompanyDeclarationSource = Readonly<{ closeGenerationId: string; hgbCloseRunChecksum: string; closingSnapshotHash: string; eBalanceArtifactId: string; eBalanceArtifactHash: string; hgbResultCents: number }>
export type CapitalCompanyDeclarationPreparation = Readonly<{ ruleVersion: string; authority: 'NON_BINDING_PREVIEW'; notice: string; preview: CapitalCompanyPreview; datasets: readonly [{ kind: 'KST'; period: string; fields: Readonly<Record<string, number>>; drilldown: Readonly<Record<string, readonly string[]>> }, { kind: 'GEWST'; period: string; fields: Readonly<Record<string, number | string>>; drilldown: Readonly<Record<string, readonly string[]>> }] }>

export function prepareCapitalCompanyDeclaration(source: CapitalCompanyDeclarationSource, facts: CapitalCompanyFacts, adjustments: readonly CapitalCompanyAdjustment[]): CapitalCompanyDeclarationPreparation {
  for (const [label, value] of Object.entries({ closeGenerationId: source.closeGenerationId, hgbCloseRunChecksum: source.hgbCloseRunChecksum, closingSnapshotHash: source.closingSnapshotHash, eBalanceArtifactId: source.eBalanceArtifactId, eBalanceArtifactHash: source.eBalanceArtifactHash })) if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required.`)
  if (!Number.isSafeInteger(source.hgbResultCents)) throw new Error('HGB result must be safe integer cents.')
  if (new Set(adjustments.map(item => item.id)).size !== adjustments.length) throw new Error('Adjustment IDs must be unique.')
  const rules = CAPITAL_COMPANY_RULES[facts.year]
  for (const adjustment of adjustments) {
    const expected = adjustment.layer === 'income-tax' ? { version: rules.adjustmentVersions.income, field: 'STEUERLICHES_ERGEBNIS' } : { version: rules.adjustmentVersions.trade, field: 'GEWERBEERTRAG' }
    if (!adjustment.id.trim() || !Number.isSafeInteger(adjustment.amountCents) || adjustment.ruleVersion !== expected.version || adjustment.field !== expected.field || !adjustment.reason.trim() || !adjustment.legalBasis.trim() || !['add-back', 'deduction'].includes(adjustment.treatment) || !adjustment.evidenceIds.length || adjustment.evidenceIds.some(id => !id.trim())) throw new Error(`Adjustment ${adjustment.id || '(blank)'} is not valid for the narrow ${facts.year} capital-company rules.`)
  }
  const income = adjustments.filter(item => item.layer === 'income-tax'); const trade = adjustments.filter(item => item.layer === 'trade-tax')
  const sum = (items: readonly CapitalCompanyAdjustment[]) => items.reduce((total, item) => { const next = total + item.amountCents; if (!Number.isSafeInteger(next)) throw new Error('Adjustment total exceeds safe integer cents.'); return next }, 0)
  const preview = calculateCapitalCompanyTax(source.hgbResultCents, sum(income), sum(trade), facts)
  const base = [source.closeGenerationId, source.hgbCloseRunChecksum, source.closingSnapshotHash, source.eBalanceArtifactId, source.eBalanceArtifactHash]
  const incomeEvidence = [...base, ...income.map(item => item.id)]; const tradeEvidence = [...incomeEvidence, ...trade.map(item => item.id)]
  const liabilityFields = facts.year === 2026
  return Object.freeze({ ruleVersion: capitalCompanyRuleVersion(facts), authority: 'NON_BINDING_PREVIEW', notice: 'Non-binding local preview only. The Finanzamt assessment is authoritative.', preview, datasets: Object.freeze([
    Object.freeze({ kind: 'KST', period: String(facts.year), fields: Object.freeze({ STEUERLICHES_ERGEBNIS: preview.taxableIncomeCents, ...(liabilityFields ? { KST_SCHULD: preview.corporationTaxCents } : {}) }), drilldown: Object.freeze({ STEUERLICHES_ERGEBNIS: Object.freeze(incomeEvidence), ...(liabilityFields ? { KST_SCHULD: Object.freeze(incomeEvidence) } : {}) }) }),
    Object.freeze({ kind: 'GEWST', period: String(facts.year), fields: Object.freeze({ GEWERBEERTRAG: preview.tradeIncomeCents, ...(liabilityFields ? { GEWST_SCHULD: preview.tradeTaxCents } : {}), GEMEINDE: facts.municipalityCode, HEBESATZ_BP: facts.hebesatzBasisPoints }), drilldown: Object.freeze({ GEWERBEERTRAG: Object.freeze(tradeEvidence), ...(liabilityFields ? { GEWST_SCHULD: Object.freeze(tradeEvidence) } : {}) }) }),
  ]) as CapitalCompanyDeclarationPreparation['datasets'] })
}
