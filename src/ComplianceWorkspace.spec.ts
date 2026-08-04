import { afterEach, describe, expect, it, vi } from 'vitest'
import { complianceHref, complianceOperationExamples, compliancePolicyRequest, historicalHgbOnboardingRequests, parseJsonObject, preparedAnnualPackages, profileRefreshMayApply, requestComplianceAction, requireEffectiveDate, supportsCapitalCompanyTaxProfile } from './ComplianceWorkspace'

describe('tenant compliance workspace', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('has a dedicated stable route and rejects non-object operation parameters', () => {
    expect(complianceHref).toBe('/compliance')
    expect(parseJsonObject('{"reason":"reviewed"}')).toEqual({ reason: 'reviewed' })
    expect(() => parseJsonObject('[]')).toThrow(/object required/)
  })

  it('accepts an explicit historical effective date for year-specific profiles and mappings', () => {
    expect(requireEffectiveDate('2025-01-01')).toBe('2025-01-01')
    expect(() => requireEffectiveDate('today')).toThrow(/effective date/i)
  })

  it('builds evidence-bound year-specific profile and mapping requests and rejects incomplete onboarding', () => {
    const profile = { ...({} as Parameters<typeof historicalHgbOnboardingRequests>[0]['profile']), sizeClass: 'MICRO', eBilanz: { accountingStandard: 'HGB' as const, incomeStatementMethod: 'GKV' as const, statementType: 'E' as const, reportStatus: 'E' as const, consolidationRange: 'EA' as const, incomeClassification: 'trade' } }
    const requests = historicalHgbOnboardingRequests({ year: 2025, profile, chartId: 'CUSTOM:HGB', mappings: [{ accountNumber: 1200 }], evidenceId: ' evidence-1 ', reason: ' register proof ' })
    expect(requests).toEqual([
      expect.objectContaining({ url: '/api/fiscal-years/2025/hgb-close/profile', body: expect.objectContaining({ evidenceId: 'evidence-1', reason: 'register proof' }) }),
      expect.objectContaining({ url: '/api/fiscal-years/2025/hgb-close/mappings', body: expect.objectContaining({ chartId: 'CUSTOM:HGB', size: 'MICRO', method: 'GKV' }) }),
    ])
    expect(() => historicalHgbOnboardingRequests({ year: 2025, profile, chartId: 'CUSTOM:HGB', mappings: [], evidenceId: '', reason: '' })).toThrow(/evidence/i)
  })

  it('offers only prepared annual-accounts packages for independent approval', () => {
    expect(preparedAnnualPackages([
      { id: 'annual-prepared', kind: 'ANNUAL_ACCOUNTS', version: 1, status: 'CREATED' },
      { id: 'annual-approved', kind: 'ANNUAL_ACCOUNTS', version: 2, status: 'APPROVED' },
      { id: 'vat-prepared', kind: 'VAT_ADVANCE', version: 1, status: 'PREPARED' },
    ])).toEqual([{ id: 'annual-prepared', kind: 'ANNUAL_ACCOUNTS', version: 1, status: 'CREATED' }])
  })

  it('builds an explicit jurisdiction and recovery policy and rejects missing operators', () => {
    expect(compliancePolicyRequest({ operatorIds: 'owner, reviewer', regions: 'DE, EU', rpo: 60, rto: 120, keyId: 'key-1', reason: 'Four-eyes recovery control' })).toEqual({ action: 'policy.configure', operatorIds: ['owner', 'reviewer'], allowedStorageRegions: ['DE', 'EU'], recoveryPointObjectiveMinutes: 60, recoveryTimeObjectiveMinutes: 120, backupKeyId: 'key-1', reason: 'Four-eyes recovery control' })
    expect(() => compliancePolicyRequest({ operatorIds: '', regions: 'DE', rpo: 60, rto: 60, keyId: 'key', reason: 'reason' })).toThrow(/Complete operator/)
  })

  it('does not let a stale refresh overwrite profile data edited after that refresh began', () => {
    expect(profileRefreshMayApply(4, 4)).toBe(true)
    expect(profileRefreshMayApply(4, 5)).toBe(false)
  })

  it('exposes annual corporation and trade-tax setup for both supported capital-company forms', () => {
    expect(supportsCapitalCompanyTaxProfile('UG')).toBe(true)
    expect(supportsCapitalCompanyTaxProfile('GMBH')).toBe(true)
    expect(supportsCapitalCompanyTaxProfile('SOLE_TRADER')).toBe(false)
  })

  it('provides usable examples for every controlled milestone workflow', () => {
    const examples = complianceOperationExamples({
      tenantId: 'tenant-a',
      profile: null, chart: null, audit: { verified: true, events: [] },
      periods: [{ id: 'period-tenant-a', referenceYear: 2026, label: 'Short year', startsAt: '2026-07-01', endsAt: '2026-09-30', status: 'OPEN' }],
      operations: { policy: null, artifacts: [{ id: 'artifact-tenant-a', objectType: 'Document', objectId: 'd', retainUntil: '2034-12-31' }], drafts: [{ id: 'draft-tenant-a', status: 'DRAFT', version: 1 }], reopenRequests: [{ id: 'request-tenant-a', status: 'PENDING', fiscalYearId: 'period-tenant-a' }], amendments: [], backups: [{ id: 'backup-tenant-a', status: 'CREATED', storageRegion: 'DE', recoveryPointAt: '2026-01-01' }] }, reportingPackages: [],
    })
    expect(Object.keys(examples)).toEqual(expect.arrayContaining(['draft.create', 'draft.revise', 'draft.post', 'entry.correct', 'period.reopen.request', 'period.reopen.decide', 'filing.amend', 'policy.configure', 'retention.hold', 'retention.reconcile', 'retention.fixity', 'retention.fixity-scan', 'retention.dispose', 'backup.create', 'backup.verify-restore']))
    expect(Object.keys(examples)).toEqual(expect.arrayContaining(['reporting.audit-export.create', 'reporting.migration-export.create', 'reporting.procedure.save', 'reporting.annual.create', 'reporting.disclosure.create', 'reporting.assets.create', 'reporting.inventory.close', 'reporting.cash-audit.create', 'reporting.package.approve']))
    expect(examples['draft.create']).toMatchObject({ fiscalPeriodId: 'period-tenant-a' })
    expect(examples['retention.hold']).toMatchObject({ artifactId: 'artifact-tenant-a' })
    expect(examples['backup.verify-restore']).toMatchObject({ backupId: 'backup-tenant-a' })
  })

  it('uses the authenticated compliance endpoint and surfaces controlled server errors', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ success: true, data: { id: 'period' } }), { status: 201, headers: { 'content-type': 'application/json' } })).mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: 'Four-eyes approval is required' }), { status: 403, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetch)
    await expect(requestComplianceAction({ action: 'period.create', ownerId: 'ignored-by-route' })).resolves.toEqual({ id: 'period' })
    expect(fetch).toHaveBeenCalledWith('/api/compliance', expect.objectContaining({ method: 'POST' }))
    await expect(requestComplianceAction({ action: 'period.reopen.decide' })).rejects.toThrow(/Four-eyes/)
  })
})
