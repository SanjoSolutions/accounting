import { prepareCapitalCompanyDeclaration, type CapitalCompanyAdjustment, type CapitalCompanyDeclarationPreparation, type CapitalCompanyDeclarationSource } from './simpleCapitalCompanyDeclaration'
import type { SimpleUg2025Facts, SimpleUg2025Preview } from './simpleUg2025Tax'

export type SimpleUg2025Adjustment = CapitalCompanyAdjustment
export type SimpleUg2025DeclarationSource = CapitalCompanyDeclarationSource
export type SimpleUg2025DeclarationPreparation = Omit<CapitalCompanyDeclarationPreparation, 'ruleVersion' | 'preview' | 'datasets'> & Readonly<{ ruleVersion: 'DE-UG-SIMPLE-2025.1'; preview: SimpleUg2025Preview; datasets: readonly [{ kind: 'KST'; period: '2025'; fields: Readonly<Record<string, number>>; drilldown: Readonly<Record<string, readonly string[]>> }, { kind: 'GEWST'; period: '2025'; fields: Readonly<Record<string, number | string>>; drilldown: Readonly<Record<string, readonly string[]>> }] }>

/** Backward-compatible wrapper for callers of the original 2025 UG API. */
export function prepareSimpleUg2025Declaration(source: SimpleUg2025DeclarationSource, facts: SimpleUg2025Facts, adjustments: readonly SimpleUg2025Adjustment[]): SimpleUg2025DeclarationPreparation {
  return prepareCapitalCompanyDeclaration(source, facts, adjustments) as SimpleUg2025DeclarationPreparation
}
