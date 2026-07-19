import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), reconcile: vi.fn(), prepare: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/vatRepository', () => ({ reconcileTenantVat: mocks.reconcile, prepareReconciledVatDataset: mocks.prepare }))
import { GET } from './route'
describe('VAT reconciliation date boundary', () => {
  it('rejects impossible calendar dates before querying tenant data', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' })
    const response = await GET(new Request('http://localhost/api/tax/vat-reconciliation?from=2026-02-31&to=2026-03-31'))
    expect(response.status).toBe(400); expect(mocks.reconcile).not.toHaveBeenCalled()
  })
})
