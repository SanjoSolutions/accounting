import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), readiness: vi.fn(), ensure: vi.fn(), history: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.auth }))
vi.mock('@/server/eric', () => ({ getEricReadiness: mocks.readiness }))
vi.mock('@/server/ledger', () => ({ ensureLedger: mocks.ensure, getEBalanceSubmissionHistory: mocks.history }))
import { GET } from './route'

describe('ERiC status API', () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.auth.mockResolvedValue({ id: 'owner' })
    mocks.readiness.mockResolvedValue({ validationReady: true, submissionReady: false, issues: ['Zertifikat fehlt.'] })
    mocks.ensure.mockResolvedValue({ status: 'CLOSED' }); mocks.history.mockResolvedValue([{ id: 'audit-1' }])
  })
  it('returns configuration readiness, fiscal status, and owner-scoped history', async () => {
    const response = await GET(new Request('http://localhost?idempotencyKey=current-key'), { params: Promise.resolve({ year: '2026' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ fiscalYearStatus: 'CLOSED', history: [{ id: 'audit-1' }] })
    expect(mocks.history).toHaveBeenCalledWith('owner', 2026, 'current-key')
  })
  it('does not disclose status to unauthenticated callers', async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await GET(new Request('http://localhost'), { params: Promise.resolve({ year: '2026' }) })).status).toBe(401)
  })
})
