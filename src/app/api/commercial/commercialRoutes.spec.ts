import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  user: vi.fn(), createPartner: vi.fn(), listPartners: vi.fn(), createDraft: vi.fn(), finalize: vi.fn(), listOpen: vi.fn(), recordPayment: vi.fn(), allocate: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/commercialAccountingRepository', async importOriginal => ({
  ...(await importOriginal<typeof import('@/server/commercialAccountingRepository')>()),
  createBusinessPartner: mocks.createPartner,
  listBusinessPartners: mocks.listPartners,
  createCommercialDocumentDraft: mocks.createDraft,
  finalizeCommercialDocument: mocks.finalize,
  listOpenItems: mocks.listOpen,
  recordPaymentSettlement: mocks.recordPayment,
  allocateSettlement: mocks.allocate,
}))

import { GET as getPartners, POST as postPartner } from './partners/route'
import { POST as postDocument } from './documents/route'
import { GET as getOpenItems } from './open-items/route'
import { POST as postAllocation } from './open-items/[id]/allocations/route'
import { POST as postPayment } from './payments/route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'tenant-a', role: 'ADMIN' })
})

describe('authenticated commercial APIs', () => {
  it('Given no current user, when a commercial route is called, then it returns 401 without reading tenant data', async () => {
    mocks.user.mockResolvedValue(null)
    const response = await getPartners(new Request('http://localhost/api/commercial/partners'))
    expect(response.status).toBe(401)
    expect(mocks.listPartners).not.toHaveBeenCalled()
  })

  it('Given an authenticated tenant, when partners and open items are listed, then ownership comes only from the session', async () => {
    mocks.listPartners.mockResolvedValue([{ id: 'partner-a' }])
    mocks.listOpen.mockResolvedValue([{ id: 'open-a' }])
    expect(await (await getPartners(new Request('http://localhost/api/commercial/partners?ownerId=tenant-b'))).json()).toMatchObject({ success: true, data: [{ id: 'partner-a' }] })
    expect(await (await getOpenItems(new Request('http://localhost/api/commercial/open-items?ownerId=tenant-b'))).json()).toMatchObject({ success: true, data: [{ id: 'open-a' }] })
    expect(mocks.listPartners).toHaveBeenCalledWith('tenant-a')
    expect(mocks.listOpen).toHaveBeenCalledWith('tenant-a')
  })

  it('Given valid partner JSON, when it is posted, then actor and owner are both session-derived', async () => {
    mocks.createPartner.mockResolvedValue({ id: 'partner-a' })
    const input = { partnerNumber: 'K-1', role: 'CUSTOMER', name: 'Customer GmbH' }
    const response = await postPartner(new Request('http://localhost/api/commercial/partners', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, ownerId: 'tenant-b' }) }))
    expect(response.status).toBe(201)
    expect(mocks.createPartner).toHaveBeenCalledWith('tenant-a', 'tenant-a', { ...input, ownerId: 'tenant-b' })
  })

  it('Given draft and finalize commands, when documents are posted, then each dispatches to the matching tenant service', async () => {
    mocks.createDraft.mockResolvedValue({ id: 'draft-a' })
    mocks.finalize.mockResolvedValue({ id: 'final-a' })
    const draftResponse = await postDocument(new Request('http://localhost/api/commercial/documents', { method: 'POST', body: JSON.stringify({ partnerId: 'partner-a' }) }))
    const finalResponse = await postDocument(new Request('http://localhost/api/commercial/documents', { method: 'POST', body: JSON.stringify({ action: 'finalize', draftId: 'draft-a' }) }))
    expect(draftResponse.status).toBe(201)
    expect(finalResponse.status).toBe(200)
    expect(mocks.createDraft).toHaveBeenCalledWith('tenant-a', 'tenant-a', { partnerId: 'partner-a' })
    expect(mocks.finalize).toHaveBeenCalledWith('tenant-a', 'tenant-a', { action: 'finalize', draftId: 'draft-a' })
  })

  it('Given a settlement request, when it is posted, then path ownership and idempotency are server controlled', async () => {
    mocks.allocate.mockResolvedValue({ id: 'allocation-a' })
    const response = await postAllocation(new Request('http://localhost/api/commercial/open-items/open-a/allocations', { method: 'POST', headers: { 'idempotency-key': 'request-0000000001' }, body: JSON.stringify({ openItemId: 'other', settlementId: 'payment-a', amountCents: 100 }) }), { params: Promise.resolve({ id: 'open-a' }) })
    expect(response.status).toBe(201)
    expect(mocks.allocate).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'request-0000000001', { openItemId: 'open-a', settlementId: 'payment-a', amountCents: 100 })
  })

  it('Given a posted payment command, when it is registered, then tenant and actor cannot be supplied by the caller', async () => {
    mocks.recordPayment.mockResolvedValue({ id: 'payment-a' })
    const body = { ownerId: 'tenant-b', businessPartnerId: 'partner-a', journalEntryId: 'journal-a', direction: 'RECEIPT', currency: 'EUR', amountCents: 100, occurredOn: '2026-08-10', reason: 'Matched' }
    const response = await postPayment(new Request('http://localhost/api/commercial/payments', { method: 'POST', body: JSON.stringify(body) }))
    expect(response.status).toBe(201)
    expect(mocks.recordPayment).toHaveBeenCalledWith('tenant-a', 'tenant-a', body)
  })
})
