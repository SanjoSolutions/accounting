import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))

import { POST } from './route'

describe('annual tax adjustment route', () => {
  it('returns a client validation response for malformed adjustment JSON', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' })
    const request = new Request('http://localhost/api/tax/annual/adjustments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year: 2026, adjustment: {} }) })
    const response = await POST(request)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ success: false, issues: [expect.stringMatching(/identifiers/)] })
  })
  it('returns 400 for valid non-object JSON', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' })
    const response = await POST(new Request('http://localhost/api/tax/annual/adjustments', { method: 'POST', body: 'null' }))
    expect(response.status).toBe(400)
  })
  it('rejects a non-four-digit tax year before persistence', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' })
    const response = await POST(new Request('http://localhost/api/tax/annual/adjustments', { method: 'POST', body: JSON.stringify({ year: -1, adjustment: {} }) }))
    expect(response.status).toBe(400)
  })
})
