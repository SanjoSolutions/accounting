import { describe, expect, it } from 'vitest'
import { canonicalJson } from './auditExport'
import { compareDottedVersions } from './deterministicOrder'
import { createEBalanceAssetAttachments, createEBalancePayloadEvidence, createEBalanceReport, createEBalanceSemanticFacts, planTaxonomyUpgrade, selectTaxonomy, type EBalanceProfile, type TaxAdjustment, type TaxonomyRelease } from './eBilanzLifecycle'

const profile: EBalanceProfile = { tenantId: 'tenant-cycle-34', companyName: 'Example GmbH', legalForm: 'GMBH', taxNumber: '1234567890', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }
const release = (version: string, successorVersion?: string): TaxonomyRelease => ({ version, validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31', gaapNamespace: `gaap-${version}`, gcdNamespace: `gcd-${version}`, entryPoint: `${version}.xsd`, archiveSha256: 'a'.repeat(64), ...(successorVersion ? { successorVersion } : {}) })
let representedPayload: unknown = {}
const serializer = { serialize: (payload: Readonly<Record<string, unknown>>) => { representedPayload = payload; return `<xbrl xmlns="http://www.xbrl.org/2003/instance">${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` }, parseRoot: () => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance', representedPayload }) }

describe('cycle 34 tax-adjustment and taxonomy-successor ordering', () => {
  it('sorts tax adjustments by stable ID before arithmetic, payload, XML and checksum generation', () => {
    const adjustments: TaxAdjustment[] = [{ id: 'z-adjustment', accountId: '7000', description: 'Z', type: 'PERMANENT', amountCents: 20, evidenceIds: ['z'] }, { id: 'a-adjustment', accountId: '6000', description: 'A', type: 'TEMPORARY', amountCents: -5, evidenceIds: ['a'] }]
    const facts = [{ concept: 'is.netIncome', context: 'duration' as const, amountCents: 100, unit: 'EUR' as const, accountIds: [] }]
    const first = createEBalanceReport(profile, release('6.10'), facts, adjustments, createEBalanceAssetAttachments(profile), serializer)
    const second = createEBalanceReport(profile, release('6.10'), facts, [...adjustments].reverse(), createEBalanceAssetAttachments(profile), serializer)
    expect(second).toEqual(first)
    expect(first.payload.taxReconciliation.adjustments.map(adjustment => adjustment.id)).toEqual(['a-adjustment', 'z-adjustment'])
  })

  it('rejects self and backward taxonomy successors while accepting a strictly newer deterministic version', () => {
    expect(() => planTaxonomyUpgrade([release('6.9', '6.9')], '6.9')).toThrow('distinct and strictly newer')
    expect(() => planTaxonomyUpgrade([release('6.9', '6.09')], '6.9')).toThrow('distinct and strictly newer')
    expect(() => planTaxonomyUpgrade([release('7.0', '6.10'), release('6.10')], '7.0')).toThrow('distinct and strictly newer')
    expect(planTaxonomyUpgrade([release('6.9', '6.10'), release('6.10')], '6.9')?.version).toBe('6.10')
  })

  it('treats zero-padded numeric components as the same registry identity while continuing at later components', () => {
    expect(compareDottedVersions('6.09', '6.9')).toBe(0)
    expect(compareDottedVersions('6.09.1', '6.9.2')).toBeLessThan(0)
    expect(() => planTaxonomyUpgrade([release('6.9'), release('6.09')], '6.9')).toThrow('duplicate or conflicting version identity')
    const registry = [release('6.9', '6.010'), release('6.10')]
    expect(planTaxonomyUpgrade(registry, '6.09')?.version).toBe('6.10')
    expect(selectTaxonomy(registry, '2026-01-01', '6.010').version).toBe('6.10')
  })
})
