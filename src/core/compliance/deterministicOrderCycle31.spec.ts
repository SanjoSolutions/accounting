import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, createAuditPackage, type AuditExportSource } from './auditExport'
import { createEBalanceAssetAttachments, createEBalancePayloadEvidence, createEBalanceReport, createEBalanceSemanticFacts, selectTaxonomy, type EBalanceFact, type EBalanceProfile, type TaxonomyRelease } from './eBilanzLifecycle'

const tenantId = 'tenant-cycle-31'
const auditSource = (): AuditExportSource => ({ masterData: [], chartMappings: [{ tenantId, accountId: 'z', name: 'Zulu' }, { tenantId, accountId: 'ä', name: 'Umlaut' }], fiscalYears: [{ tenantId, id: 'FY', startDate: '2026-01-01', endDate: '2026-12-31' }], journal: [], journalLines: [], openingClosing: [{ tenantId, fiscalYearId: 'FY', accountId: 'z', openingCents: 1, closingCents: 1 }, { tenantId, fiscalYearId: 'FY', accountId: 'ä', openingCents: -1, closingCents: -1 }], vatDetails: [], evidence: [], auditEvents: [], taxSubmissions: [], openItems: [] })
const access = { tenantId, actorId: 'auditor', authorityReference: 'AO-2026-31', accessedAt: '2026-07-18T18:00:00Z', purpose: 'AUDIT' as const }
const profile: EBalanceProfile = { tenantId, companyName: 'Example GmbH', legalForm: 'GMBH', taxNumber: '1234567890', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }
const taxonomy = (version: string): TaxonomyRelease => ({ version, validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31', gaapNamespace: `gaap-${version}`, gcdNamespace: `gcd-${version}`, entryPoint: `${version}.xsd`, archiveSha256: 'a'.repeat(64) })
const facts: EBalanceFact[] = [{ concept: 'is.netIncome', context: 'duration', amountCents: 0, unit: 'EUR', accountIds: [] }, { concept: 'z.concept', context: 'instant', amountCents: 1, unit: 'EUR', accountIds: [] }, { concept: 'ä.concept', context: 'instant', amountCents: 2, unit: 'EUR', accountIds: [] }]
let representedPayload: unknown = {}
const serializer = { serialize: (payload: Readonly<Record<string, unknown>>) => { representedPayload = payload; return `<xbrl xmlns="http://www.xbrl.org/2003/instance">${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` }, parseRoot: () => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance', representedPayload }) }

describe('cycle 31 locale-independent compliance artifact ordering', () => {
  it('creates identical audit and E-Bilanz artifacts when host collation behavior changes', async () => {
    const expectedAudit = await createAuditPackage(auditSource(), access, { record: vi.fn() })
    const expectedEBilanz = createEBalanceReport(profile, taxonomy('6.10'), facts, [], createEBalanceAssetAttachments(profile), serializer)
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(function (this: string, other: string) { return this < other ? 1 : this > other ? -1 : 0 })
    try {
      expect(await createAuditPackage(auditSource(), access, { record: vi.fn() })).toEqual(expectedAudit)
      expect(createEBalanceReport(profile, taxonomy('6.10'), facts, [], createEBalanceAssetAttachments(profile), serializer)).toEqual(expectedEBilanz)
      expect(selectTaxonomy([taxonomy('6.9'), taxonomy('6.10')], '2026-01-01').version).toBe('6.10')
    } finally { localeCompare.mockRestore() }
  })
})
