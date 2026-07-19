import { describe, expect, it } from 'vitest'
import { canonicalJson } from './auditExport'
import { createEBalanceAssetAttachments, createEBalancePayloadEvidence, createEBalanceReport, createEBalanceSemanticFacts, type EBalanceProfile, type EBalanceSupportingBalance, type TaxonomyRelease } from './eBilanzLifecycle'

const tenantId = 'tenant-cycle-35'
const profile: EBalanceProfile = { tenantId, companyName: 'Example GmbH', legalForm: 'GMBH', taxNumber: '1234567890', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }
const taxonomy: TaxonomyRelease = { version: '6.10', validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31', gaapNamespace: 'gaap-6.10', gcdNamespace: 'gcd-6.10', entryPoint: '6.10.xsd', archiveSha256: 'a'.repeat(64) }
let representedPayload: unknown = {}
const serializer = { serialize: (payload: Readonly<Record<string, unknown>>) => { representedPayload = payload; return `<xbrl xmlns="http://www.xbrl.org/2003/instance">${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` }, parseRoot: () => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance', representedPayload }) }
const commercialFacts = [{ concept: 'is.netIncome', context: 'duration' as const, amountCents: 0, unit: 'EUR' as const, accountIds: [] }]

function balance(kind: EBalanceSupportingBalance['kind']): EBalanceSupportingBalance {
  return { id: kind.toLowerCase(), kind, tenantId, fiscalPeriodStart: profile.fiscalPeriodStart, fiscalPeriodEnd: profile.fiscalPeriodEnd, facts: [{ concept: 'z.fact', context: 'instant', amountCents: 2, unit: 'EUR', accountIds: [] }, { concept: 'a.fact', context: 'duration', amountCents: 1, unit: 'EUR', accountIds: [] }], reconciliation: [{ id: 'z-row', accountId: 'z', description: 'Z', commercialAmountCents: 0, taxAmountCents: 2, differenceCents: 2, evidenceIds: ['z'] }, { id: 'a-row', accountId: 'a', description: 'A', commercialAmountCents: 0, taxAmountCents: 1, differenceCents: 1, evidenceIds: ['a'] }] }
}

describe('cycle 35 normalized E-Bilanz optionals and supporting balances', () => {
  it('treats explicitly undefined optional profile and attachment fields exactly like omission', () => {
    const omitted = createEBalanceReport(profile, taxonomy, commercialFacts, [], createEBalanceAssetAttachments(profile), serializer)
    const explicit = createEBalanceReport({ ...profile, specialBalanceRequired: undefined, supplementaryBalanceRequired: undefined }, taxonomy, commercialFacts, [], { ...createEBalanceAssetAttachments(profile), specialBalance: undefined, supplementaryBalance: undefined }, serializer)
    expect(explicit).toEqual(omitted)
    expect(Object.hasOwn(explicit.payload.gcd, 'specialBalanceRequired')).toBe(false)
    expect(Object.hasOwn(explicit.payload.attachments, 'specialBalance')).toBe(false)
  })

  it('canonicalizes attachment keys, supporting facts and reconciliation rows across permutations', () => {
    const special = balance('SPECIAL_BALANCE'); const supplementary = balance('SUPPLEMENTARY_BALANCE')
    const required = { ...profile, specialBalanceRequired: true, supplementaryBalanceRequired: true }
    const first = createEBalanceReport(required, taxonomy, commercialFacts, [], { ...createEBalanceAssetAttachments(required), supplementaryBalance: supplementary, specialBalance: special }, serializer)
    const reversedSpecial = { ...special, facts: [...special.facts].reverse(), reconciliation: [...special.reconciliation].reverse() }
    const reversedSupplementary = { ...supplementary, facts: [...supplementary.facts].reverse(), reconciliation: [...supplementary.reconciliation].reverse() }
    const second = createEBalanceReport(required, taxonomy, commercialFacts, [], { ...createEBalanceAssetAttachments(required), specialBalance: reversedSpecial, supplementaryBalance: reversedSupplementary }, serializer)
    expect(second).toEqual(first)
    expect(first.payload.attachments.specialBalance?.facts.map(fact => fact.concept)).toEqual(['a.fact', 'z.fact'])
    expect(first.payload.attachments.specialBalance?.reconciliation.map(row => row.id)).toEqual(['a-row', 'z-row'])
  })
})
