import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), process: vi.fn() }))
vi.mock('server-only', () => ({})); vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser })); vi.mock('@/server/ledger', () => ({ processEBalanceWithEric: mocks.process }))
import { POST } from './route'
describe('ERiC submission API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getCurrentUser.mockResolvedValue({ id: 'owner' }) })
  it('requires an explicit confirmation and PIN', async () => {
    expect((await POST(request(JSON.stringify({ ...validData(), pin: '123456' })), context())).status).toBe(400)
    expect((await POST(request(JSON.stringify({ ...validData(), confirmed: true })), context())).status).toBe(400)
    expect(mocks.process).not.toHaveBeenCalled()
  })
  it('passes the ephemeral PIN only to the submission process', async () => {
    mocks.process.mockResolvedValue({ statusCode: 0, statusText: 'accepted', sent: true })
    const response = await POST(request(JSON.stringify({ ...validData(), pin: '123456', confirmed: true, idempotencyKey: 'request-123456789' })), context())
    expect(response.status).toBe(200)
    expect(mocks.process).toHaveBeenCalledWith('owner', 2026, validData(), { send: true, pin: '123456', confirmed: true, idempotencyKey: 'request-123456789' })
  })
  it('does not report success when ERiC validates but does not send', async () => {
    mocks.process.mockResolvedValue({ statusCode: 0, statusText: 'not sent', sent: false })
    const response = await POST(request(JSON.stringify({ ...validData(), pin: '123456', confirmed: true, idempotencyKey: 'request-unsent' })), context())
    expect(response.status).toBe(422)
    await expect(response.json()).resolves.toMatchObject({ success: false, sent: false })
  })
})
function validData() { return { companyName: 'A GmbH', street: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'GMBH' } }
function request(body: string) { return new Request('http://localhost', { method: 'POST', body }) }
function context() { return { params: Promise.resolve({ year: '2026' }) } }
