import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  getAccountingReport: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/accountingReports', async importOriginal => {
  const original = await importOriginal<typeof import('@/server/accountingReports')>()
  return { ...original, getAccountingReport: mocks.getAccountingReport }
})

import { GET } from './route'

describe('accounting reports API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1' })
  })

  it('requires an authenticated tenant', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)

    const response = await GET(request('?year=2025'))

    expect(response.status).toBe(401)
    expect(mocks.getAccountingReport).not.toHaveBeenCalled()
  })

  it.each(['', '?year=', '?year=2025.5', '?year=25', '?year=2201'])(
    'rejects the invalid fiscal year in %s',
    async suffix => {
      const response = await GET(request(suffix))

      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ success: false, error: expect.stringContaining('year') })
      expect(mocks.getAccountingReport).not.toHaveBeenCalled()
    },
  )

  it('loads only the authenticated tenant and requested fiscal year', async () => {
    const report = { year: 2025, generatedAt: '2026-07-31T10:00:00.000Z' }
    mocks.getAccountingReport.mockResolvedValue(report)

    const response = await GET(request('?year=2025'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(report)
    expect(mocks.getAccountingReport).toHaveBeenCalledWith('owner-1', 2025)
  })

  it('returns a clear not-found response when the imported setup is missing', async () => {
    const { AccountingReportNotFoundError } = await import('@/server/accountingReports')
    mocks.getAccountingReport.mockRejectedValue(new AccountingReportNotFoundError(2025))

    const response = await GET(request('?year=2025'))

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      success: false,
      error: 'No imported accounting setup exists for fiscal year 2025.',
    })
  })

  it('returns a clear bad-request response when the persisted setup is invalid', async () => {
    const { AccountingReportInvalidSetupError } = await import('@/server/accountingReports')
    mocks.getAccountingReport.mockRejectedValue(new AccountingReportInvalidSetupError(['currency is missing.']))

    const response = await GET(request('?year=2025'))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      success: false,
      error: expect.stringContaining('invalid'),
      issues: ['currency is missing.'],
    })
  })
})

function request(suffix: string) {
  return new Request(`http://localhost/api/accounting-reports${suffix}`)
}
