import { describe, expect, it, test, vi } from 'vitest'
import { TaxDeclarationError } from '@/core/taxDeclarations'
const mocks = vi.hoisted(() => ({ user: vi.fn(), reconcile: vi.fn(), prepare: vi.fn(), preview: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/vatRepository', () => ({ reconcileTenantVat: mocks.reconcile, prepareReconciledVatDataset: mocks.prepare, currentReconciledVatDataset: mocks.preview }))
import { GET } from './route'
describe('VAT reconciliation date boundary', () => {
  it('rejects impossible calendar dates before querying tenant data', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' })
    const response = await GET(new Request('http://localhost/api/tax/vat-reconciliation?from=2026-02-31&to=2026-03-31'))
    expect(response.status).toBe(400); expect(mocks.reconcile).not.toHaveBeenCalled()
  })
  test('Given an authenticated quarterly filer, when Q1 is requested, then the canonical quarter is prepared', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' }); mocks.prepare.mockResolvedValue({ dataset: { period: '2026-Q1' } })
    const response = await GET(new Request('http://localhost/api/tax/vat-reconciliation?period=2026-Q1'))
    expect(response.status).toBe(200)
    expect(mocks.prepare).toHaveBeenCalledWith('tenant-a', '2026-Q1')
  })
  test('Given a VAT preview request, when Q3 is requested, then the non-persisting calculation path is used', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' }); mocks.preview.mockResolvedValue({ dataset: { period: '2026-Q3' } })
    const response = await GET(new Request('http://localhost/api/tax/vat-reconciliation?period=2026-Q3&preview=1'))
    expect(response.status).toBe(200)
    expect(mocks.preview).toHaveBeenCalledWith('tenant-a', '2026-Q3')
    expect(mocks.prepare).not.toHaveBeenCalledWith('tenant-a', '2026-Q3')
  })
  test('Given a quarter without one covering profile version, when preparation fails, then the API returns the validation issue as JSON', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' })
    mocks.prepare.mockRejectedValue(new TaxDeclarationError(['A canonical company-profile version covering the complete filing period is required.']))
    const response = await GET(new Request('http://localhost/api/tax/vat-reconciliation?period=2026-Q3'))
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toEqual({ success: false, issues: ['A canonical company-profile version covering the complete filing period is required.'] })
  })
  test('Given an unexpected repository failure, when preparation fails, then the API still returns a JSON error contract', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' })
    mocks.prepare.mockRejectedValue(new Error('database details must not leak'))
    const response = await GET(new Request('http://localhost/api/tax/vat-reconciliation?period=2026-Q3'))
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ success: false, issues: ['VAT reconciliation could not be prepared.'] })
  })
})
