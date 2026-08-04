import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), prepare: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/narrowUgAnnualRepository', () => ({ prepareNarrowCapitalCompanyAnnualTax: mocks.prepare }))

import { POST } from './route'

describe('POST /api/tax/annual/narrow', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' }); mocks.prepare.mockResolvedValue({ caseId: 'case-1', authority: 'NON_BINDING_PREVIEW', datasets: [] }) })

  it('prepares the authenticated tenant 2025 UG dataset without caller-authored declaration values', async () => {
    const response = await POST(new Request('http://localhost/api/tax/annual/narrow', { method: 'POST', body: JSON.stringify({ year: 2025 }) }))
    expect(response.status).toBe(201)
    expect(mocks.prepare).toHaveBeenCalledWith('tenant-a', 'user-a', 2025)
    expect(await response.json()).toMatchObject({ data: { authority: 'NON_BINDING_PREVIEW' } })
  })

  it('prepares the authenticated tenant 2026 capital-company dataset without caller-authored declaration values', async () => {
    const response = await POST(new Request('http://localhost/api/tax/annual/narrow', { method: 'POST', body: JSON.stringify({ year: 2026 }) }))
    expect(response.status).toBe(201)
    expect(mocks.prepare).toHaveBeenCalledWith('tenant-a', 'user-a', 2026)
  })

  it('fails closed for any assessment year outside the installed narrow profiles', async () => {
    const response = await POST(new Request('http://localhost/api/tax/annual/narrow', { method: 'POST', body: JSON.stringify({ year: 2027 }) }))
    expect(response.status).toBe(400)
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
