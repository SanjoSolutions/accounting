import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), ensure: vi.fn(), workspace: vi.fn(), create: vi.fn() }))
vi.mock('server-only', () => ({})); vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user })); vi.mock('@/server/ledger', () => ({ ensureLedger: mocks.ensure })); vi.mock('@/server/fixedAssetsRepository', () => ({ getFixedAssetWorkspace: mocks.workspace, createFixedAsset: mocks.create, FixedAssetError: class FixedAssetError extends Error { constructor(message: string, readonly status = 400) { super(message) } } }))
import { GET, POST } from './route'

describe('fixed-asset register API', () => {
  beforeEach(() => vi.clearAllMocks())
  it('rejects anonymous register access', async () => { mocks.user.mockResolvedValue(null); expect((await GET(new Request('http://localhost/api/fixed-assets'))).status).toBe(401); expect(mocks.workspace).not.toHaveBeenCalled() })
  it('loads only the authenticated tenant workspace after ledger bootstrap', async () => { mocks.user.mockResolvedValue({ id: 'tenant-a' }); mocks.workspace.mockResolvedValue({ assets: [] }); const response = await GET(new Request('http://localhost/api/fixed-assets')); expect(response.status).toBe(200); expect(mocks.workspace).toHaveBeenCalledWith('tenant-a') })
  it('registers acquisition evidence with the authenticated actor', async () => { mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' }); mocks.create.mockResolvedValue({ id: 'asset-a' }); const input = { description: 'Laptop', acquisitionDate: '2026-01-10' }; const response = await POST(new Request('http://localhost/api/fixed-assets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })); expect(response.status).toBe(201); expect(mocks.ensure).toHaveBeenCalledWith('tenant-a', 2026); expect(mocks.create).toHaveBeenCalledWith('tenant-a', 'user-a', input) })
})
