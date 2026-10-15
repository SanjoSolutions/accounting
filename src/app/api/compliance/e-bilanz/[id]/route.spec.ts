import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), authorize: vi.fn(), download: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/compliance/runtime', () => ({ authorizeComplianceTenant: mocks.authorize, complianceError: () => Response.json({ success: false }, { status: 404 }) }))
vi.mock('@/server/compliance/eBilanzReportActions', () => ({ downloadEBalanceReport: mocks.download }))
import { GET } from './route'

describe('authenticated retained report download', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'owner', actorId: 'reader', role: 'READ_ONLY' }); mocks.authorize.mockResolvedValue('owner') })
  const request = () => GET(new Request('http://local/api/compliance/e-bilanz/report?tenantId=owner'), { params: Promise.resolve({ id: 'report' }) })
  test('given a read-only tenant member, returns exact bytes with private no-store headers and the real actor', async () => {
    mocks.download.mockResolvedValue({ content: Buffer.from('<retained/>'), contentType: 'application/xml', fileName: 'e-bilanz-v1.xml' })
    const response = await request()
    expect(await response.text()).toBe('<retained/>')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="e-bilanz-v1.xml"')
    expect(mocks.authorize).toHaveBeenCalledWith('owner', 'owner')
    expect(mocks.download).toHaveBeenCalledWith('owner', 'reader', 'report')
  })
  test('given no session, refuses access without reading storage', async () => {
    mocks.user.mockResolvedValue(null)
    expect((await request()).status).toBe(401)
    expect(mocks.download).not.toHaveBeenCalled()
  })
  test('given a foreign tenant request, refuses access before downloading', async () => {
    mocks.authorize.mockRejectedValue(new Error('Tenant denied'))
    expect((await request()).status).toBe(404)
    expect(mocks.download).not.toHaveBeenCalled()
  })
})
