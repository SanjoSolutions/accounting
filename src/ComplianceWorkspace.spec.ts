import { afterEach, describe, expect, it, vi } from 'vitest'
import { complianceHref, complianceOperationExamples, parseJsonObject, requestComplianceAction } from './ComplianceWorkspace'

describe('tenant compliance workspace', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('has a dedicated stable route and rejects non-object operation parameters', () => {
    expect(complianceHref).toBe('/compliance')
    expect(parseJsonObject('{"reason":"reviewed"}')).toEqual({ reason: 'reviewed' })
    expect(() => parseJsonObject('[]')).toThrow(/object required/)
  })

  it('provides usable examples for every controlled milestone workflow', () => {
    const examples = complianceOperationExamples({
      tenantId: 'tenant-a',
      profile: null, chart: null, audit: { verified: true, events: [] },
      periods: [{ id: 'period-tenant-a', referenceYear: 2026, label: 'Short year', startsAt: '2026-07-01', endsAt: '2026-09-30', status: 'OPEN' }],
      operations: { policy: null, artifacts: [{ id: 'artifact-tenant-a', objectType: 'Document', objectId: 'd', retainUntil: '2034-12-31' }], drafts: [{ id: 'draft-tenant-a', status: 'DRAFT', version: 1 }], reopenRequests: [{ id: 'request-tenant-a', status: 'PENDING', fiscalYearId: 'period-tenant-a' }], amendments: [], backups: [{ id: 'backup-tenant-a', status: 'CREATED', storageRegion: 'DE', recoveryPointAt: '2026-01-01' }] },
    })
    expect(Object.keys(examples)).toEqual(expect.arrayContaining(['draft.create', 'draft.revise', 'draft.post', 'entry.correct', 'period.reopen.request', 'period.reopen.decide', 'filing.amend', 'policy.configure', 'retention.hold', 'retention.reconcile', 'retention.fixity', 'retention.fixity-scan', 'retention.dispose', 'backup.create', 'backup.verify-restore']))
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
