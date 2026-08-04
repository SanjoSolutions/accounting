import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ user: vi.fn(), create: vi.fn(), list: vi.fn(), import: vi.fn(), transactions: vi.fn(), confirm: vi.fn(), reverse: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/bankingRepository', async importOriginal => ({ ...(await importOriginal<typeof import('@/server/bankingRepository')>()), createBankAccount: mocks.create, listBankAccounts: mocks.list, importCamtStatement: mocks.import, listBankTransactionsWithSuggestions: mocks.transactions, confirmBankTransactionMatch: mocks.confirm, reverseBankTransactionMatch: mocks.reverse }))

import { GET as getAccounts, POST as postAccount } from './accounts/route'
import { POST as postStatement } from './statements/route'
import { GET as getTransactions } from './transactions/route'
import { POST as confirmMatch } from './transactions/[id]/matches/route'
import { POST as reverseMatch } from './matches/[id]/reversals/route'

beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'user-a', role: 'ADMIN' }) })

describe('authenticated banking APIs', () => {
  it('Given no current user, when banking data is requested, then the API returns 401 without repository access', async () => {
    mocks.user.mockResolvedValue(null); const response = await getAccounts(new Request('http://localhost/api/banking/accounts'))
    expect(response.status).toBe(401); expect(mocks.list).not.toHaveBeenCalled()
  })
  it('Given a read-only member, when a split bank allocation is attempted, then the API returns 403 without repository access', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'viewer-a', role: 'READ_ONLY' })
    const response = await confirmMatch(new Request('http://localhost/api/banking/transactions/tx-a/matches', { method: 'POST', headers: { 'idempotency-key': 'bank-request-00001' }, body: JSON.stringify({ allocations: [{ openItemId: 'open-a', amountCents: 100 }], reason: 'Not permitted' }) }), { params: Promise.resolve({ id: 'tx-a' }) })
    expect(response.status).toBe(403); expect(mocks.confirm).not.toHaveBeenCalled()
  })
  it('Given an authenticated user, when bank accounts and transactions are listed, then owner scope comes only from the session', async () => {
    mocks.list.mockResolvedValue([]); mocks.transactions.mockResolvedValue([])
    await getAccounts(new Request('http://localhost/api/banking/accounts?ownerId=tenant-b')); await getTransactions(new Request('http://localhost/api/banking/transactions?ownerId=tenant-b'))
    expect(mocks.list).toHaveBeenCalledWith('tenant-a'); expect(mocks.transactions).toHaveBeenCalledWith('tenant-a')
  })
  it('Given bank setup JSON, when posted, then owner and actor are session-derived', async () => {
    mocks.create.mockResolvedValue({ id: 'bank-a' }); const body = { name: 'Bank', iban: 'DE44', ledgerAccountId: 'ledger-a', ownerId: 'tenant-b' }
    expect((await postAccount(new Request('http://localhost/api/banking/accounts', { method: 'POST', body: JSON.stringify(body) }))).status).toBe(201)
    expect(mocks.create).toHaveBeenCalledWith('tenant-a', 'user-a', body)
  })
  it('Given CAMT bytes and a selected account, when imported, then both tenant identities are server-controlled', async () => {
    mocks.import.mockResolvedValue({ imported: 1, skipped: 0 }); const bytes = '<Document/>'
    const response = await postStatement(new Request('http://localhost/api/banking/statements', { method: 'POST', headers: { 'x-bank-account-id': 'bank-a' }, body: bytes }))
    expect(response.status).toBe(201); expect(mocks.import).toHaveBeenCalledWith('tenant-a', 'user-a', 'bank-a', new Uint8Array(Buffer.from(bytes)))
  })
  it('Given explicit confirmation and reversal commands, when posted, then path IDs, tenant, actor, and idempotency are server-controlled', async () => {
    mocks.confirm.mockResolvedValue({ id: 'match-a' }); mocks.reverse.mockResolvedValue({ id: 'reversal-a' })
    const confirmBody = { allocations: [{ openItemId: 'open-a', amountCents: 100 }, { openItemId: 'open-b', amountCents: 200 }], reason: 'Confirmed split' }; const reversalBody = { effectiveDate: '2026-08-04', reason: 'Reversed' }
    expect((await confirmMatch(new Request('http://localhost/api/banking/transactions/tx-a/matches', { method: 'POST', headers: { 'idempotency-key': 'bank-request-00001' }, body: JSON.stringify(confirmBody) }), { params: Promise.resolve({ id: 'tx-a' }) })).status).toBe(201)
    expect((await reverseMatch(new Request('http://localhost/api/banking/matches/match-a/reversals', { method: 'POST', headers: { 'idempotency-key': 'reverse-request-001' }, body: JSON.stringify(reversalBody) }), { params: Promise.resolve({ id: 'match-a' }) })).status).toBe(201)
    expect(mocks.confirm).toHaveBeenCalledWith('tenant-a', 'user-a', 'tx-a', 'bank-request-00001', confirmBody)
    expect(mocks.reverse).toHaveBeenCalledWith('tenant-a', 'user-a', 'match-a', 'reverse-request-001', reversalBody)
  })
})
