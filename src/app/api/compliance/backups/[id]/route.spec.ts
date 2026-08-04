import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), authorize: vi.fn(), download: vi.fn(), verify: vi.fn(), error: vi.fn((error: Error) => Response.json({ success: false, error: error.message }, { status: 409 })) }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/compliance/runtime', () => ({ authorizeComplianceTenant: mocks.authorize, downloadTenantBackupPayload: mocks.download, verifyTenantBackupPayload: mocks.verify, complianceError: mocks.error }))
import { GET, POST } from './route'

const args = { params: Promise.resolve({ id: 'backup-a' }) }
describe('operator tenant-backup artifact API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' }); mocks.authorize.mockResolvedValue('tenant-a') })
  it('Given an authorized operator, when a backup is downloaded, then the exact encrypted artifact is returned without caching', async () => {
    mocks.download.mockResolvedValue({ content: Buffer.from('{"encrypted":"x"}'), fileName: 'backup-a.tenant-backup.json' })
    const response = await GET(new Request('http://localhost/api/compliance/backups/backup-a'), args)
    expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store'); expect(await response.text()).toContain('encrypted')
  })
  it('Given uploaded encrypted bytes, when isolated verification is requested, then tenant scope and exact bytes reach the verifier', async () => {
    mocks.verify.mockResolvedValue({ isolatedRestore: true })
    const response = await POST(new Request('http://localhost/api/compliance/backups/backup-a', { method: 'POST', body: '{"encrypted":"x"}' }), args)
    expect(response.status).toBe(200); expect(mocks.verify).toHaveBeenCalledWith('tenant-a', 'user-a', 'backup-a', expect.any(Uint8Array))
  })
  it('Given an empty payload, when verification is requested, then it is rejected before restore mutation', async () => {
    const response = await POST(new Request('http://localhost/api/compliance/backups/backup-a', { method: 'POST', body: '' }), args)
    expect(response.status).toBe(400); expect(mocks.verify).not.toHaveBeenCalled()
  })
})
