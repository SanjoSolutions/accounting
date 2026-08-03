import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), prepare: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/narrowUgAnnualRepository', () => ({ prepareNarrowUgAnnualTax: mocks.prepare }))

import { POST } from './route'

describe('POST /api/tax/annual/narrow', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a' }); mocks.prepare.mockResolvedValue({ caseId: 'case-1', authority: 'NON_BINDING_PREVIEW', datasets: [] }) })

  it('prepares the authenticated tenant 2025 UG dataset without caller-authored declaration values', async () => {
    const response = await POST(new Request('http://localhost/api/tax/annual/narrow', { method: 'POST', body: JSON.stringify({ year: 2025 }) }))
    expect(response.status).toBe(201)
    expect(mocks.prepare).toHaveBeenCalledWith('tenant-a', 'tenant-a')
    expect(await response.json()).toMatchObject({ data: { authority: 'NON_BINDING_PREVIEW' } })
  })

  it('fails closed for any assessment year outside the installed narrow profile', async () => {
    const response = await POST(new Request('http://localhost/api/tax/annual/narrow', { method: 'POST', body: JSON.stringify({ year: 2026 }) }))
    expect(response.status).toBe(400)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
