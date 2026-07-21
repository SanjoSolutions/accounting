import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), authorize: vi.fn(), overview: vi.fn(), mappings: vi.fn(), mappingAudit: vi.fn(), period: vi.fn(), draft: vi.fn(), revise: vi.fn(), post: vi.fn(), correct: vi.fn(), reopen: vi.fn(), decide: vi.fn(), amend: vi.fn(), confirmAddress: vi.fn(), policy: vi.fn(), hold: vi.fn(), reconcile: vi.fn(), fixity: vi.fn(), fixityScan: vi.fn(), dispose: vi.fn(), backup: vi.fn(), restore: vi.fn(), error: vi.fn((error: unknown) => { throw error }),
  reportingOverview: vi.fn(), createDomainPackage: vi.fn(), approvePackage: vi.fn(), saveProcedure: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/compliance/runtime', () => ({
  authorizeComplianceTenant: mocks.authorize, complianceError: mocks.error, getComplianceOverview: mocks.overview, resolveMappings: mocks.mappings, mappingAuditExport: mocks.mappingAudit,
  createFiscalPeriod: mocks.period, createDraft: mocks.draft, reviseDraft: mocks.revise, postDraft: mocks.post, correctPostedEntry: mocks.correct,
  requestPeriodReopen: mocks.reopen, decidePeriodReopen: mocks.decide, createFilingAmendment: mocks.amend, confirmHistoricalProfileAddress: mocks.confirmAddress, configureCompliancePolicy: mocks.policy,
  placeLegalHold: mocks.hold, reconcileDocumentArtifacts: mocks.reconcile, runFixityCheck: mocks.fixity, runDueFixityChecks: mocks.fixityScan, disposeArtifact: mocks.dispose, createTenantBackup: mocks.backup, verifyTenantRestore: mocks.restore,
}))
vi.mock('@/server/compliance/reportingRepository', () => ({ getReportingOverview: mocks.reportingOverview, createDomainReportingPackage: mocks.createDomainPackage, approveReportingPackage: mocks.approvePackage, saveProcedureDocument: mocks.saveProcedure }))
import { GET, POST } from './route'

describe('compliance production API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getCurrentUser.mockResolvedValue({ id: 'tenant-a' }); mocks.authorize.mockImplementation(async (actorId: string, requested?: unknown) => typeof requested === 'string' && requested ? requested : actorId); mocks.overview.mockResolvedValue({ periods: [] }) })
  it('requires authentication for reads and writes', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    expect((await GET(new Request('http://localhost/api/compliance'))).status).toBe(401)
    expect((await POST(json({ action: 'period.create' }))).status).toBe(401)
  })
  it('always scopes overview and mapping history to the authenticated tenant', async () => {
    await GET(new Request('http://localhost/api/compliance'))
    await GET(new Request('http://localhost/api/compliance?view=mapping-audit'))
    expect(mocks.overview).toHaveBeenCalledWith('tenant-a', expect.any(Date))
    expect(mocks.mappingAudit).toHaveBeenCalledWith('tenant-a')
  })
  it('tenant-scopes reporting reads and package, approval, and procedure writes', async () => {
    mocks.reportingOverview.mockResolvedValue({ packages: [] })
    await GET(new Request('http://localhost/api/compliance?view=reporting&tenantId=tenant-b'))
    expect((await POST(json({ action: 'reporting.package.create', tenantId: 'tenant-b', kind: 'ANNUAL_ACCOUNTS', payload: {}, reason: 'prepared' }))).status).toBe(400)
    await POST(json({ action: 'reporting.package.approve', tenantId: 'tenant-b', packageId: 'package-1', reason: 'established' }))
    await POST(json({ action: 'reporting.procedure.save', tenantId: 'tenant-b', document: {}, reason: 'versioned' }))
    expect(mocks.reportingOverview).toHaveBeenCalledWith('tenant-b')
    expect(mocks.approvePackage).toHaveBeenCalledWith('tenant-b', 'tenant-a', 'package-1', 'established')
    expect(mocks.saveProcedure).toHaveBeenCalledWith('tenant-b', 'tenant-a', expect.anything())
  })
  it('routes every reporting workflow with a server-selected package kind', async () => {
    const actions = {
      'reporting.audit-export.create': 'AUDIT_EXPORT', 'reporting.migration-export.create': 'MIGRATION_EXPORT',
      'reporting.annual.create': 'ANNUAL_ACCOUNTS',
      'reporting.assets.create': 'ASSET_SCHEDULE', 'reporting.inventory.close': 'INVENTORY_CLOSE', 'reporting.cash-audit.create': 'CASH_AUDIT',
    }
    for (const [action, kind] of Object.entries(actions)) {
      await POST(json({ action, kind: 'caller-cannot-override', payload: {}, reason: 'controlled workflow' }))
      expect(mocks.createDomainPackage).toHaveBeenLastCalledWith('tenant-a', 'tenant-a', kind, expect.objectContaining({ action }))
    }
    await POST(json({ action: 'reporting.disclosure.create', kind: 'caller-cannot-override', fiscalPeriodId: 'fy', deadline: '2027-12-31', reason: 'controlled workflow' }))
    expect(mocks.createDomainPackage).toHaveBeenLastCalledWith('tenant-a', 'tenant-a', 'DISCLOSURE_PACKAGE', expect.objectContaining({ action: 'reporting.disclosure.create' }))
  })
  it('routes stable-period and draft workflows with the authenticated actor', async () => {
    mocks.period.mockResolvedValue({ id: 'period' }); mocks.draft.mockResolvedValue({ id: 'draft' }); mocks.post.mockResolvedValue({ id: 'entry' })
    expect((await POST(json({ action: 'period.create', referenceYear: 2026 }))).status).toBe(201)
    await POST(json({ action: 'draft.create', fiscalPeriodId: 'period' }))
    await POST(json({ action: 'draft.post', draftId: 'draft', reason: 'approved' }))
    expect(mocks.period).toHaveBeenCalledWith('tenant-a', 'tenant-a', expect.objectContaining({ referenceYear: 2026 }))
    expect(mocks.draft).toHaveBeenCalledWith('tenant-a', 'tenant-a', expect.anything())
    expect(mocks.post).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'draft', 'approved')
  })
  it('routes correction, four-eyes reopen and amended-filing actions without caller-supplied tenant ids', async () => {
    for (const body of [
      { action: 'entry.correct', entryId: 'entry', reason: 'error' },
      { action: 'period.reopen.request', periodId: 'period', reason: 'adjustment' },
      { action: 'period.reopen.decide', requestId: 'request', approve: true, reason: 'reviewed' },
      { action: 'filing.amend', originalObjectId: 'filing', reason: 'corrected' },
    ]) expect((await POST(json({ ...body, ownerId: 'tenant-b' }))).status).toBe(201)
    expect(mocks.correct).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'entry', expect.anything())
    expect(mocks.reopen).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'period', 'adjustment')
    expect(mocks.decide).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'request', true, 'reviewed')
    expect(mocks.amend).toHaveBeenCalledWith('tenant-a', 'tenant-a', expect.objectContaining({ ownerId: 'tenant-b' }))
  })
  it('routes an explicit historical profile address confirmation with tenant and actor scope', async () => {
    const address = { streetAndHouseNumber: 'Old 1', zipCode: '12345', city: 'Oldtown', country: 'DE' }
    expect((await POST(json({ action: 'profile.address-confirm', profileVersionId: 'profile-v1', address, reason: 'Historical register evidence' }))).status).toBe(201)
    expect(mocks.confirmAddress).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'profile-v1', address, 'Historical register evidence')
  })
  it('keeps tenant scope separate from the authenticated actor for four-eyes approval', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'approver-b' })
    await POST(json({ action: 'period.reopen.decide', tenantId: 'tenant-a', requestId: 'request', approve: true, reason: 'independent review' }))
    expect(mocks.authorize).toHaveBeenCalledWith('approver-b', 'tenant-a')
    expect(mocks.decide).toHaveBeenCalledWith('tenant-a', 'approver-b', 'request', true, 'independent review')
  })
  it('routes retention and operator recovery actions', async () => {
    for (const body of [
      { action: 'policy.configure', reason: 'policy' }, { action: 'retention.hold', artifactId: 'a', until: '2040-01-01', reason: 'audit' },
      { action: 'retention.reconcile', reason: 'migration reconciliation' },
      { action: 'retention.fixity', artifactId: 'a', reason: 'schedule' }, { action: 'retention.dispose', artifactId: 'a', onDate: '2041-01-01', reason: 'expired' },
      { action: 'retention.fixity-scan', before: '2026-07-19', reason: 'nightly schedule' },
      { action: 'backup.create', region: 'DE', reason: 'schedule' }, { action: 'backup.verify-restore', backupId: 'b', measuredRestoreMinutes: 5, reason: 'exercise' },
    ]) expect((await POST(json(body))).status).toBe(201)
    expect(mocks.backup).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'DE', 'schedule')
    expect(mocks.restore).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'b', 5, 'exercise')
  })
  it('rejects unknown actions without dispatching a mutation', async () => {
    const response = await POST(json({ action: 'unknown' }))
    expect(response.status).toBe(400)
    expect(mocks.period).not.toHaveBeenCalled()
  })
  it('rejects JSON null and array bodies as controlled client errors', async () => {
    expect((await POST(json(null))).status).toBe(400)
    expect((await POST(json([]))).status).toBe(400)
    expect(mocks.authorize).not.toHaveBeenCalled()
  })
  it('requires an explicit boolean reopen decision before mutating the request', async () => {
    for (const approve of [undefined, null, 'true']) {
      const response = await POST(json({ action: 'period.reopen.decide', requestId: 'request', approve, reason: 'reviewed' }))
      expect(response.status).toBe(400)
    }
    expect(mocks.decide).not.toHaveBeenCalled()
  })
  it('requires an explicit finite numeric restore-duration measurement', async () => {
    for (const measuredRestoreMinutes of [undefined, null, '', '0', Number.NaN]) {
      const response = await POST(json({ action: 'backup.verify-restore', backupId: 'backup', measuredRestoreMinutes, reason: 'exercise' }))
      expect(response.status).toBe(400)
    }
    expect(mocks.restore).not.toHaveBeenCalled()
  })
})

function json(body: unknown) { return new Request('http://localhost/api/compliance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
