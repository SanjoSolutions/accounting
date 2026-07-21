import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createEBalanceAssetAttachments, createEBalanceReport, type TaxonomyRelease } from '@/core/compliance/eBilanzLifecycle'
import { allowUnqualifiedEBalanceDrafts, assertEBalanceDraftReadiness, canonicalXbrlSerializer, createEBalanceLedgerFacts, createEBalanceReconciliationChecksum, deriveAuthoritativeEBalanceProfile, eBalanceLifecycleReadiness, taxonomyArchiveStorageKey, verifyTaxonomyArchive } from './eBilanzIntegration'

const archive = new TextEncoder().encode('official taxonomy fixture')
const taxonomy: TaxonomyRelease = { version: '6.10', validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31', gaapNamespace: 'urn:gaap:6.10', gcdNamespace: 'urn:gcd:6.10', entryPoint: 'taxonomy.xsd', archiveSha256: createHash('sha256').update(archive).digest('hex') }
const period = { id: 'fy-2026', startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-12-31T23:59:59Z'), status: 'CLOSED' }
const profilePayload = { companyName: 'Example GmbH', legalForm: 'GMBH', taxNumber: '1234567890', eBilanz: { accountingStandard: 'HGB', incomeStatementMethod: 'UKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade', specialBalanceRequired: false } }

describe('durable E-Bilanz integration boundaries', () => {
  it('binds reconciliation checksums to the fiscal year and reconciliation kind', () => {
    const payload = '{"differenceCents":100}'
    const adjustment2026 = createEBalanceReconciliationChecksum('fy-2026', 'ADJUSTMENT', payload)
    expect(createEBalanceReconciliationChecksum('fy-2026', 'ADJUSTMENT', payload)).toBe(adjustment2026)
    expect(createEBalanceReconciliationChecksum('fy-2027', 'ADJUSTMENT', payload)).not.toBe(adjustment2026)
    expect(createEBalanceReconciliationChecksum('fy-2026', 'SPECIAL_BALANCE', payload)).not.toBe(adjustment2026)
  })

  it('verifies official taxonomy archives and derives every reporting fact from effective profile and period records', () => {
    expect(verifyTaxonomyArchive(taxonomy, archive)).toBe(taxonomy.archiveSha256)
    expect(() => verifyTaxonomyArchive(taxonomy, new TextEncoder().encode('tampered'))).toThrow('checksum')
    const profile = deriveAuthoritativeEBalanceProfile('tenant-1', period, profilePayload)
    expect(profile).toMatchObject({ tenantId: 'tenant-1', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', incomeStatementMethod: 'UKV' })
    expect(() => deriveAuthoritativeEBalanceProfile('tenant-1', period, { ...profilePayload, eBilanz: {} })).toThrow('profile fact')
  })

  it('produces canonical XBRL and fails readiness closed until every durable and external gate is satisfied', () => {
    const profile = deriveAuthoritativeEBalanceProfile('tenant-1', period, profilePayload)
    const facts = [{ concept: 'is.netIncome', context: 'duration' as const, amountCents: 100, unit: 'EUR' as const, accountIds: ['account-1'] }]
    const report = createEBalanceReport(profile, taxonomy, facts, [], createEBalanceAssetAttachments(profile), canonicalXbrlSerializer())
    expect(report.content).toContain('<xbrl xmlns="http://www.xbrl.org/2003/instance">')
    const blocked = eBalanceLifecycleReadiness({ profile, taxonomy, fiscalYearStatus: 'CLOSED', facts, reconciliationKinds: ['ADJUSTMENT'], assetScheduleReady: true, ericQualified: false })
    expect(blocked.ready).toBe(false); expect(blocked.checks.find(check => check.code === 'ERIC_QUALIFICATION')?.ready).toBe(false)
    expect(eBalanceLifecycleReadiness({ profile, taxonomy, fiscalYearStatus: 'CLOSED', facts, reconciliationKinds: ['ADJUSTMENT'], assetScheduleReady: true, ericQualified: true }).ready).toBe(true)
  })

  it('allows only the external qualification gate to be relaxed by server policy', () => {
    expect(allowUnqualifiedEBalanceDrafts({ E_BILANZ_ALLOW_UNQUALIFIED_DRAFTS: 'true' })).toBe(true)
    expect(allowUnqualifiedEBalanceDrafts({ E_BILANZ_ALLOW_UNQUALIFIED_DRAFTS: 'false' })).toBe(false)
    const profile = deriveAuthoritativeEBalanceProfile('tenant-1', period, profilePayload)
    const facts = [{ concept: 'is.netIncome' }]
    const externallyBlocked = eBalanceLifecycleReadiness({ profile, taxonomy, fiscalYearStatus: 'CLOSED', facts, reconciliationKinds: ['ADJUSTMENT'], assetScheduleReady: true, ericQualified: false })
    expect(() => assertEBalanceDraftReadiness(externallyBlocked, true)).not.toThrow()
    expect(() => assertEBalanceDraftReadiness(externallyBlocked, false)).toThrow('ERIC_QUALIFICATION')
    const internallyBlocked = eBalanceLifecycleReadiness({ profile, taxonomy, fiscalYearStatus: 'OPEN', facts, reconciliationKinds: ['ADJUSTMENT'], assetScheduleReady: true, ericQualified: false })
    expect(() => assertEBalanceDraftReadiness(internallyBlocked, true)).toThrow('LEDGER')
  })

  it('includes inactive accounts with fiscal postings and rejects every nonzero unmapped balance', () => {
    const facts = createEBalanceLedgerFacts([
      { id: 'inactive-posted', active: false, category: 'ASSET', eBilanzPosition: 'bs.ass', journalLines: [{ debitCents: 250, creditCents: 0 }] },
      { id: 'inactive-empty', active: false, category: 'ASSET', eBilanzPosition: 'bs.ass', journalLines: [] },
    ])
    expect(facts.find(fact => fact.concept === 'bs.ass')).toMatchObject({ amountCents: 250, accountIds: ['inactive-posted'] })
    expect(() => createEBalanceLedgerFacts([{ id: 'unmapped', active: false, category: 'ASSET', eBilanzPosition: null, journalLines: [{ debitCents: 1, creditCents: 0 }] }])).toThrow('unmapped')
    expect(() => createEBalanceLedgerFacts([{ id: 'zero-unmapped', active: true, category: 'ASSET', eBilanzPosition: null, journalLines: [{ debitCents: 1, creditCents: 1 }] }])).not.toThrow()
  })

  it('assigns each taxonomy registration an ownership-specific archive key', () => {
    const first = taxonomyArchiveStorageKey(taxonomy, 'attempt-1')
    const second = taxonomyArchiveStorageKey(taxonomy, 'attempt-2')
    expect(first).not.toBe(second)
    expect(first).toContain(`${taxonomy.version}-${taxonomy.archiveSha256}`)
  })
})
