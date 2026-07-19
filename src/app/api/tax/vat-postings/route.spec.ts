import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn(), persist: vi.fn(), parse: vi.fn((value: unknown) => value) }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/vatRepository', () => ({ listVatPostings: mocks.list, parsePersistentVatInput: mocks.parse, persistVatPosting: mocks.persist }))
import { GET, POST } from './route'

describe('structured VAT posting route', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a' }) })
  it('persists the complete source split under the authenticated tenant', async () => {
    const input = { sourceId: 'line-1', amountCents: 11900, mode: 'gross', taxPoint: '2026-01-02', ruleId: 'DE_STANDARD', direction: 'sale', journalLineId: 'journal-line-1', documentId: 'document-1' }
    mocks.persist.mockResolvedValue({ netBaseCents: 10000, taxCents: 1900 })
    expect((await POST(request(input))).status).toBe(201)
    expect(mocks.parse).toHaveBeenCalledWith(input)
    expect(mocks.persist).toHaveBeenCalledWith('tenant-a', input)
  })
  it('tenant-scopes VAT drilldown history', async () => { mocks.list.mockResolvedValue([]); await GET(new Request('http://localhost/api/tax/vat-postings')); expect(mocks.list).toHaveBeenCalledWith('tenant-a') })
})
function request(body: unknown) { return new Request('http://localhost/api/tax/vat-postings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
