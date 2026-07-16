import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), process: vi.fn() }))
vi.mock('server-only', () => ({})); vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser })); vi.mock('@/server/ledger', () => ({ processEBalanceWithEric: mocks.process }))
import { POST } from './route'
describe('ERiC validation API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getCurrentUser.mockResolvedValue({ id: 'owner' }) })
  it('validates without ever accepting a PIN', async () => {
    mocks.process.mockResolvedValue({ statusCode: 0, statusText: 'ok' })
    const response = await POST(request(JSON.stringify(validData())), context())
    expect(response.status).toBe(200)
    expect(mocks.process).toHaveBeenCalledWith('owner', 2026, validData(), { send: false })
  })
  it('rejects incomplete master data', async () => { expect((await POST(request('{}'), context())).status).toBe(400); expect(mocks.process).not.toHaveBeenCalled() })
})
function validData() { return { companyName: 'A GmbH', street: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'GMBH' } }
function request(body: string) { return new Request('http://localhost', { method: 'POST', body }) }
function context() { return { params: Promise.resolve({ year: '2026' }) } }
