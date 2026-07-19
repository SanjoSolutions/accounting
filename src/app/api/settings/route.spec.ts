import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSettings: vi.fn(async () => ({ id: 'company:local' })),
  updateSettings: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/auth', () => ({
  auth: { api: { getSession: mocks.getSession } },
}))
vi.mock('@/server', () => ({
  getSettings: mocks.getSettings,
  updateSettings: mocks.updateSettings,
}))

import { GET, PUT } from './route'
import { CompanyProfileValidationError } from '@/server/compliance/companyProfile'

const originalAuthMode = process.env.AUTH_MODE

describe('settings API authentication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(() => {
    if (originalAuthMode === undefined) delete process.env.AUTH_MODE
    else process.env.AUTH_MODE = originalAuthMode
  })

  it('remains available in local no-auth mode', async () => {
    process.env.AUTH_MODE = 'none'

    const response = await GET(new Request('http://localhost/api/settings'))

    expect(response.status).toBe(200)
    expect(mocks.getSettings).toHaveBeenCalledOnce()
    expect(mocks.getSettings).toHaveBeenCalledWith('local')
    expect(mocks.getSession).not.toHaveBeenCalled()
  })

  it('rejects an anonymous request in credential mode', async () => {
    process.env.AUTH_MODE = 'credentials'
    mocks.getSession.mockResolvedValueOnce(null)

    const response = await GET(new Request('http://localhost/api/settings'))

    expect(response.status).toBe(401)
    expect(mocks.getSettings).not.toHaveBeenCalled()
  })

  it('allows an authenticated request in credential mode', async () => {
    process.env.AUTH_MODE = 'credentials'
    mocks.getSession.mockResolvedValueOnce({
      user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' },
    })

    const response = await GET(new Request('http://localhost/api/settings'))

    expect(response.status).toBe(200)
    expect(mocks.getSettings).toHaveBeenCalledOnce()
    expect(mocks.getSettings).toHaveBeenCalledWith('user-1')
  })

  it('saves SKR04 as the selected chart of accounts', async () => {
    process.env.AUTH_MODE = 'none'
    const settings = {
      chartOfAccounts: 'SKR04',
      invoiceIssuer: { name: 'Example GmbH' },
    }

    const response = await PUT(new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }))

    expect(response.status).toBe(200)
    expect(mocks.updateSettings).toHaveBeenCalledWith(settings, 'local', 'local')
  })

  it('never shares settings between authenticated tenants', async () => {
    process.env.AUTH_MODE = 'credentials'
    mocks.getSession.mockResolvedValueOnce({ user: { id: 'tenant-b', name: 'B', email: 'b@example.com' } })
    await GET(new Request('http://localhost/api/settings'))
    expect(mocks.getSettings).toHaveBeenCalledWith('tenant-b')
  })

  it('exposes report applicability derived from the authoritative tenant profile', async () => {
    process.env.AUTH_MODE = 'none'
    mocks.getSettings.mockResolvedValueOnce({ id: 'company:local', companyProfile: { companyName: 'Example KG', legalForm: 'KG', taxNumber: '12/345/67890', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Trade', sizeClass: 'SMALL', chart: 'SKR04', elections: [] } } as never)
    const response = await GET(new Request('http://localhost/api/settings'))
    expect((await response.json()).data.reportApplicability).toMatchObject({ VAT_ADVANCE: { applicable: true, overridden: false }, E_BILANZ: { applicable: true } })
  })

  it('rejects an unsupported chart of accounts', async () => {
    process.env.AUTH_MODE = 'none'

    const response = await PUT(new Request('http://localhost/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chartOfAccounts: 'SKR05' }),
    }))

    expect(response.status).toBe(400)
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('does not expose or misclassify persistence failures as client validation', async () => {
    process.env.AUTH_MODE = 'none'
    mocks.updateSettings.mockRejectedValueOnce(new Error('database contains sensitive detail'))
    await expect(PUT(new Request('http://localhost/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).rejects.toThrow('database contains sensitive detail')
  })

  it('returns 400 only for dedicated company-profile validation failures', async () => {
    process.env.AUTH_MODE = 'none'
    mocks.updateSettings.mockRejectedValueOnce(new CompanyProfileValidationError('companyName is required'))
    const response = await PUT(new Request('http://localhost/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }))
    expect(response.status).toBe(400)
    mocks.updateSettings.mockRejectedValueOnce(new TypeError('unexpected programming error'))
    await expect(PUT(new Request('http://localhost/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).rejects.toThrow('unexpected programming error')
  })
})
