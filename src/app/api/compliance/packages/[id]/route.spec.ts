import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), authorize: vi.fn(), download: vi.fn(), error: vi.fn((error: Error) => Response.json({ success: false, error: error.message }, { status: 409 })) }))
vi.mock('server-only', () => ({})); vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user })); vi.mock('@/server/compliance/runtime', () => ({ authorizeComplianceTenant: mocks.authorize, complianceError: mocks.error })); vi.mock('@/server/compliance/reportingRepository', () => ({ downloadReportingPackage: mocks.download }))
import { GET } from './route'

describe('GoBD package download API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'user-a', actorId: 'actor-a' }); mocks.authorize.mockResolvedValue('tenant-a'); mocks.download.mockResolvedValue({ content: Buffer.from('{"manifest":{}}'), fileName: 'gobd-audit-2026-v1.json', contentHash: 'a'.repeat(64) }) })
  it('Given an authenticated tenant, when a retained package is downloaded, then exact bytes, fixity and no-store headers are returned', async () => { const response = await GET(new Request('http://localhost/api/compliance/packages/package-a'), { params: Promise.resolve({ id: 'package-a' }) }); expect(response.status).toBe(200); expect(await response.text()).toBe('{"manifest":{}}'); expect(response.headers.get('content-disposition')).toContain('gobd-audit-2026-v1.json'); expect(response.headers.get('x-content-sha256')).toBe('a'.repeat(64)); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(mocks.download).toHaveBeenCalledWith('tenant-a', 'actor-a', 'package-a') })
  it('Given no authenticated user, when download is attempted, then package lookup is never called', async () => { mocks.user.mockResolvedValue(null); const response = await GET(new Request('http://localhost/api/compliance/packages/package-a'), { params: Promise.resolve({ id: 'package-a' }) }); expect(response.status).toBe(401); expect(mocks.download).not.toHaveBeenCalled() })
})
