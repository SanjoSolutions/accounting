import { beforeEach, describe, expect, it, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  reconcile: vi.fn(),
  register: vi.fn(),
  issue: vi.fn(),
  list: vi.fn(),
  configureNumbering: vi.fn(), reconcileNumbering: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.auth }))
vi.mock('@/server/commercialAccountingRepository', () => ({
  reconcilePendingOutgoingInvoiceAccounting: mocks.reconcile,
  registerOutgoingStructuredInvoice: mocks.register,
}))
vi.mock('@/server/tax/structuredInvoices', () => ({
  configureInvoiceNumberSequence: mocks.configureNumbering,
  issueStructuredInvoice: mocks.issue,
  listStructuredInvoices: mocks.list,
  reconcileInvoiceNumberSequence: mocks.reconcileNumbering,
  requireInvoiceIssuanceBody: (value: unknown) => value,
}))

import { GET, POST } from './route'

describe('structured-invoice API accounting recovery boundary', () => {
  const numberingRequest = (action = 'reconcile-number-sequence') => new Request('http://localhost/api/tax/e-invoices', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, year: 2026, firstUnusedNumber: 42, importedInvoiceNumbers: ['2026-000041'], confirmedExistingSeries: true, ownerId: 'untrusted-owner', actorId: 'untrusted-actor' }),
  })
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' })
    mocks.reconcile.mockResolvedValue([])
    mocks.list.mockResolvedValue([{ id: 'invoice-a' }])
    mocks.issue.mockResolvedValue({ id: 'invoice-a' })
    mocks.register.mockResolvedValue({ id: 'commercial-a' })
  })

  test.each(['ACCOUNTANT', 'READ_ONLY'])('Given a %s member, when either numbering setup action is requested, then it is rejected before mutation', async role => {
    mocks.auth.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role })
    for (const action of ['configure-number-sequence', 'reconcile-number-sequence']) expect((await POST(numberingRequest(action))).status).toBe(403)
    expect(mocks.configureNumbering).not.toHaveBeenCalled(); expect(mocks.reconcileNumbering).not.toHaveBeenCalled(); expect(mocks.issue).not.toHaveBeenCalled()
  })

  test('Given an administrator, when imported numbering is reconciled, then tenant and confirmer come only from the authenticated principal', async () => {
    mocks.reconcileNumbering.mockResolvedValue({ year: 2026, nextValue: 42 })
    expect((await POST(numberingRequest())).status).toBe(201)
    expect(mocks.reconcileNumbering).toHaveBeenCalledWith('tenant-a', 'user-a', 2026, 42, ['2026-000041'], true)
    expect(mocks.issue).not.toHaveBeenCalled()
  })

  test('Given no authenticated principal, when onboarding is requested, then no numbering state is accessed', async () => {
    mocks.auth.mockResolvedValue(null)
    expect((await POST(numberingRequest())).status).toBe(401)
    expect(mocks.reconcileNumbering).not.toHaveBeenCalled()
  })

  it('Given an authenticated invoice-list visit, when an orphan may exist, then accounting reconciliation finishes before invoices are exposed', async () => {
    const order: string[] = []
    mocks.reconcile.mockImplementation(async () => { order.push('reconcile'); return [] })
    mocks.list.mockImplementation(async () => { order.push('list'); return [{ id: 'invoice-a' }] })
    const response = await GET(new Request('http://localhost/api/tax/e-invoices'))
    expect(response.status).toBe(200)
    expect(order).toEqual(['reconcile', 'list'])
    expect(mocks.reconcile).toHaveBeenCalledWith('tenant-a', 'user-a')
  })

  it('Given invoice issuance, when accounting registration fails, then the API never returns a false 201 success', async () => {
    mocks.register.mockRejectedValueOnce(new Error('simulated accounting failure'))
    await expect(POST(new Request('http://localhost/api/tax/e-invoices', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'invoice', requestKey: 'request-key-123456' }) }))).rejects.toThrow(/accounting failure/)
    expect(mocks.issue).toHaveBeenCalledOnce()
    expect(mocks.register).toHaveBeenCalledWith('tenant-a', 'user-a', 'invoice-a')
  })

  it('Given no authenticated tenant, when invoices are listed, then recovery and data access are both blocked', async () => {
    mocks.auth.mockResolvedValueOnce(null)
    const response = await GET(new Request('http://localhost/api/tax/e-invoices'))
    expect(response.status).toBe(401)
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(mocks.list).not.toHaveBeenCalled()
  })
})
