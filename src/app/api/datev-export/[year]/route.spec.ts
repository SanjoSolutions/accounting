import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), export: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/datevExport', () => ({ exportDatevBookingBatch: mocks.export }))
import { POST } from './route'

describe('DATEV export API', () => {
  beforeEach(() => vi.clearAllMocks())
  it('Given no authenticated user, when export is requested, then no tenant data is read', async () => { mocks.user.mockResolvedValue(null); const response = await request('2026'); expect(response.status).toBe(401); expect(mocks.export).not.toHaveBeenCalled() })
  it('Given an authenticated tenant, when export succeeds, then deterministic attachment and provenance headers are returned', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' }); mocks.export.mockResolvedValue({ bytes: Buffer.from('csv'), fileName: 'EXTF_Buchungsstapel_2026.csv', contentHash: 'a'.repeat(64), retainedArtifactId: 'artifact-a' })
    const response = await request('2026')
    expect(mocks.export).toHaveBeenCalledWith('tenant-a', 'user-a', 2026)
    expect(response.headers.get('content-disposition')).toContain('EXTF_Buchungsstapel_2026.csv')
    expect(response.headers.get('x-content-sha256')).toBe('a'.repeat(64))
  })
})

function request(year: string) { return POST(new Request(`http://localhost/api/datev-export/${year}`, { method: 'POST' }), { params: Promise.resolve({ year }) }) }
