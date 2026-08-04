import { calculateCapitalCompanyTax, type CapitalCompanyFacts, type CapitalCompanyPreview } from './simpleCapitalCompanyTax'

export const SIMPLE_UG_2025_RULE_VERSION = 'DE-UG-SIMPLE-2025.1'
export type SimpleUg2025Facts = CapitalCompanyFacts & Readonly<{ legalForm: 'UG'; year: 2025 }>
export type SimpleUg2025Preview = CapitalCompanyPreview & Readonly<{ ruleVersion: typeof SIMPLE_UG_2025_RULE_VERSION }>

/** Backward-compatible wrapper for the original supported profile. */
export function calculateSimpleUg2025Tax(hgbResultCents: number, incomeTaxAdjustmentsCents: number, tradeTaxAdjustmentsCents: number, facts: SimpleUg2025Facts): SimpleUg2025Preview {
  return calculateCapitalCompanyTax(hgbResultCents, incomeTaxAdjustmentsCents, tradeTaxAdjustmentsCents, facts) as SimpleUg2025Preview
}
