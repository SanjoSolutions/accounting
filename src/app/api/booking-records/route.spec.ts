import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountingValidationError } from '@/core/doubleEntry'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(), postJournalEntry: vi.fn(), getLedgerWorkspace: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/ledger', () => ({
  postJournalEntry: mocks.postJournalEntry, getLedgerWorkspace: mocks.getLedgerWorkspace,
}))
import { POST } from './route'

describe('posting API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects anonymous postings', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    expect((await POST(request({}))).status).toBe(401)
  })

  it('returns all accounting validation issues', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1' })
    mocks.postJournalEntry.mockRejectedValue(new AccountingValidationError(['Soll und Haben stimmen nicht überein.']))
    const response = await POST(request({ lines: [] }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ issues: ['Soll und Haben stimmen nicht überein.'] })
  })

  it('creates a valid immutable journal entry for the owner', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1' })
    mocks.postJournalEntry.mockResolvedValue({ id: 'entry-1' })
    const body = { bookingDate: '2026-01-01', description: 'Test', lines: [], documentIds: ['document-1', 'document-2'] }
    const response = await POST(request(body))
    expect(response.status).toBe(201)
    expect(mocks.postJournalEntry).toHaveBeenCalledWith('owner-1', body)
  })

  it('returns 400 for malformed JSON instead of an internal error', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1' })
    const response = await POST(new Request('http://localhost/api/booking-records', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    }))
    expect(response.status).toBe(400)
  })
})

function request(body: unknown) {
  return new Request('http://localhost/api/booking-records', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
}
