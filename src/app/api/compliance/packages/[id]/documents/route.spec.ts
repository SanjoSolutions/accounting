import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), authorize: vi.fn(), create: vi.fn(), options: vi.fn(), download: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/compliance/runtime', () => ({ authorizeComplianceTenant: mocks.authorize, complianceError: (error: Error) => Response.json({ error: error.message }, { status: 409 }) }))
vi.mock('@/server/compliance/annualDocumentRepository', () => ({ annualDocumentOptions: mocks.options, createAnnualDocumentBundle: mocks.create, downloadAnnualDocument: mocks.download }))
import { GET, POST } from './route'
const context = { params: Promise.resolve({ id: 'exact-version' }) }
const url = 'http://127.0.0.1:3113/api/compliance/packages/exact-version/documents'

describe('annual document route authorization and responses', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'actor-a', role: 'ADMIN' }); mocks.authorize.mockResolvedValue('tenant-a'); mocks.download.mockResolvedValue({ content: Buffer.from('<html>retained</html>'), fileName: 'jahresabschluss.html', contentType: 'text/html; charset=utf-8', contentHash: 'abc' }); mocks.create.mockResolvedValue({ id: 'export-a' }) })
  test('Given an authorized request, when reading an exact export, then retained bytes are private, non-cacheable and sandboxed', async () => {
    const response = await GET(new Request(`${url}?artifactId=export-a&file=jahresabschluss.html`), context)
    expect(mocks.download).toHaveBeenCalledWith('tenant-a', 'actor-a', 'exact-version', 'export-a', 'jahresabschluss.html')
    expect(await response.text()).toBe('<html>retained</html>'); expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('content-security-policy')).toContain('sandbox'); expect(response.headers.get('x-content-sha256')).toBe('abc')
  })
  test('Given no session or foreign tenant access, when requesting a document, then no source bytes are read', async () => {
    mocks.user.mockResolvedValue(null)
    expect((await GET(new Request(url), context)).status).toBe(401)
    mocks.user.mockResolvedValue({ id: 'tenant-b', actorId: 'actor-b', role: 'ADMIN' }); mocks.authorize.mockRejectedValue(new Error('Forbidden tenant'))
    expect((await GET(new Request(`${url}?tenantId=tenant-a&artifactId=export-a`), context)).status).toBe(409)
    expect(mocks.download).not.toHaveBeenCalled(); expect(mocks.options).not.toHaveBeenCalled()
  })
  test('Given a read-only user, when creating an export, then write permission is required', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'actor-a', role: 'READ_ONLY' })
    const response = await POST(new Request(url, { method: 'POST', body: '{}' }), context)
    expect(response.status).toBe(403); expect(mocks.create).not.toHaveBeenCalled(); expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
  test('Given a permitted source selection, when creating an export, then selection and immutable identity reach the repository', async () => {
    const body = { mode: 'annual', expectedChecksum: 'hash' }
    const response = await POST(new Request(url, { method: 'POST', body: JSON.stringify(body) }), context)
    expect(response.status).toBe(201); expect(mocks.create).toHaveBeenCalledWith('tenant-a', 'actor-a', 'exact-version', body)
  })
})
