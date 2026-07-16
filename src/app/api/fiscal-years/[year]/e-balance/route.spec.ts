import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), exportEBalance: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/ledger', () => ({ exportEBalance: mocks.exportEBalance }))
import { POST } from './route'

describe('E-Bilanz export API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1' }) })

  it('returns 400 for malformed JSON and missing string master data', async () => {
    const malformed = await POST(request('{'), { params: Promise.resolve({ year: '2026' }) })
    expect(malformed.status).toBe(400)
    const missing = await POST(request('{}'), { params: Promise.resolve({ year: '2026' }) })
    expect(missing.status).toBe(400)
    expect(mocks.exportEBalance).not.toHaveBeenCalled()
  })

  it('returns an XBRL attachment for valid data', async () => {
    mocks.exportEBalance.mockResolvedValue(new Uint8Array([80, 75]))
    const masterData = { companyName: 'A GmbH', street: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'GMBH' }
    const response = await POST(request(JSON.stringify(masterData)), { params: Promise.resolve({ year: '2026' }) })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/zip')
    expect(mocks.exportEBalance).toHaveBeenCalledWith('owner-1', 2026, masterData)
  })

  it('rejects an unsupported legal form', async () => {
    const response = await POST(request('{"companyName":"A","street":"Weg 1","postalCode":"10115","city":"Berlin","taxNumber":"1234567890123","legalForm":"INVALID"}'), { params: Promise.resolve({ year: '2026' }) })
    expect(response.status).toBe(400)
    expect(mocks.exportEBalance).not.toHaveBeenCalled()
  })
})

function request(body: string) { return new Request('http://localhost/api/fiscal-years/2026/e-balance', { method: 'POST', headers: { 'content-type': 'application/json' }, body }) }
