import { describe, expect, it } from 'vitest'
import { canonicalJson } from './auditExport'
import { createEBalanceAssetAttachments, createEBalancePayloadEvidence, createEBalanceReport, createEBalanceSemanticFacts, type EBalanceFact, type EBalanceProfile, type TaxonomyRelease } from './eBilanzLifecycle'

const profile: EBalanceProfile = { tenantId: 'tenant-cycle-32', companyName: 'Example GmbH', legalForm: 'GMBH', taxNumber: '1234567890', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }
const taxonomy: TaxonomyRelease = { version: '6.10', validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31', gaapNamespace: 'gaap-6.10', gcdNamespace: 'gcd-6.10', entryPoint: '6.10.xsd', archiveSha256: 'a'.repeat(64) }
let representedPayload: unknown = {}
const serializer = { serialize: (payload: Readonly<Record<string, unknown>>) => { representedPayload = payload; return `<xbrl xmlns="http://www.xbrl.org/2003/instance">${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` }, parseRoot: () => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance', representedPayload }) }

describe('cycle 32 composite E-Bilanz fact ordering', () => {
  it('orders equal-concept facts by context so input order cannot change XML or checksum', () => {
    const netIncome: EBalanceFact = { concept: 'is.netIncome', context: 'duration', amountCents: 0, unit: 'EUR', accountIds: [] }
    const duration: EBalanceFact = { concept: 'shared.concept', context: 'duration', amountCents: 1, unit: 'EUR', accountIds: [] }
    const instant: EBalanceFact = { concept: 'shared.concept', context: 'instant', amountCents: 2, unit: 'EUR', accountIds: [] }
    const first = createEBalanceReport(profile, taxonomy, [netIncome, instant, duration], [], createEBalanceAssetAttachments(profile), serializer)
    const second = createEBalanceReport(profile, taxonomy, [duration, netIncome, instant], [], createEBalanceAssetAttachments(profile), serializer)
    expect(first).toEqual(second)
    expect(first.payload.facts.map(fact => `${fact.concept}:${fact.context}`)).toEqual(['is.netIncome:duration', 'shared.concept:duration', 'shared.concept:instant'])
  })
})
