import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ committed: [] as unknown[], failReplacement: true }))
const account = { id: 'cash', number: 1000, name: 'Cash', category: 'ASSET', eBilanzPosition: 'cash', active: true }
const counterAccount = { id: 'bank', number: 1200, name: 'Bank', category: 'ASSET', eBilanzPosition: 'bank', active: true }
const period = { id: 'fy', ownerId: 'tenant', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31T23:59:59.999Z'), status: 'OPEN' }

const prismaMock = vi.hoisted(() => ({
  fiscalYear: { findMany: vi.fn(async () => [period]) },
  ledgerAccount: { findMany: vi.fn(async () => [account, counterAccount]) },
  documentRecord: { count: vi.fn(async () => 0) },
  ledgerProfile: { findUniqueOrThrow: vi.fn(async () => ({ ownerId: 'tenant', chart: 'SKR03' })) },
  $transaction: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('./persistence/client', () => ({ prisma: prismaMock }))
vi.mock('./compliance/auditPersistence', () => ({ appendAuditEvent: vi.fn() }))
vi.mock('./storage', () => ({ getDocumentStorage: vi.fn() }))

import { correctionPostingFingerprint, documentRetentionExtension, postJournalCorrection, resolveCorrectionEntryDate } from './ledger'

describe('atomic correction posting', () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.committed.length = 0; state.failReplacement = true
    prismaMock.$transaction.mockImplementation(async (callback: (transaction: any) => Promise<unknown>) => {
      const pending: unknown[] = []
      let creates = 0
      const transaction = {
        fiscalYear: { updateMany: vi.fn(async () => ({ count: 1 })), findMany: vi.fn(async () => []) },
        ledgerAccount: { findMany: vi.fn(async () => [account, counterAccount]) },
        ledgerProfile: { findUniqueOrThrow: vi.fn(async () => ({ ownerId: 'tenant', chart: 'SKR03' })) },
        documentRecord: { count: vi.fn(async () => 0) },
        journalEntry: {
          findFirst: vi.fn(async ({ where }: any) => where?.id === 'original' ? { id: 'original', state: 'POSTED' } : null),
          findUnique: vi.fn(async () => null),
          create: vi.fn(async ({ data }: any) => {
            creates++
            if (creates === 2 && state.failReplacement) throw new Error('replacement failed')
            const entry = { id: creates === 1 ? 'reversal' : 'replacement', ...data, lines: [], documents: [] }
            pending.push(entry); return entry
          }),
        },
      }
      const result = await callback(transaction)
      state.committed.push(...pending)
      return result
    })
  })

  it('rolls back the reversal when replacement creation fails', async () => {
    const reversal = posting('STORNO-1')
    const replacement = posting('REPLACEMENT-1')
    await expect(postJournalCorrection('tenant', 'requester', 'original', reversal, replacement, '2026-07-19', 'incorrect amount')).rejects.toThrow('replacement failed')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    expect(state.committed).toEqual([])
  })
  it('allows historical reversal accounts to be inactive while requiring active replacement accounts', async () => {
    state.failReplacement = false
    await postJournalCorrection('tenant', 'requester', 'original', posting('STORNO-1'), posting('REPLACEMENT-1'), '2026-07-19', 'incorrect amount')
    const accountQueries = prismaMock.ledgerAccount.findMany.mock.calls as unknown as Array<[{ where: Record<string, unknown> }]>
    expect(accountQueries[0][0].where).not.toHaveProperty('active')
    expect(accountQueries[1][0].where).toMatchObject({ active: true })
  })
  it('distinguishes a semantic correction retry from conflicting replacement data', () => {
    const base = { fiscalYearId: 'fy', bookingDate: '2026-07-01', documentNumber: 'R-1', description: 'Correction', source: 'CORRECTION', entryDate: '2026-07-19', lateReason: 'reason', reversalOfId: null, replacementOfId: 'original', externalKey: 'key', lines: [{ accountId: 'cash', debitCents: 100, creditCents: 0 }, { accountId: 'bank', debitCents: 0, creditCents: 100 }], documentIds: [] }
    expect(correctionPostingFingerprint(base)).toBe(correctionPostingFingerprint({ ...base, lines: [...base.lines].reverse() }))
    expect(correctionPostingFingerprint(base)).not.toBe(correctionPostingFingerprint({ ...base, lines: [{ ...base.lines[0], debitCents: 200 }, base.lines[1]] }))
  })
  it('uses a server-controlled correction entry date', () => {
    const now = new Date('2026-07-19T12:00:00Z')
    expect(resolveCorrectionEntryDate(undefined, new Date('2026-07-18T12:00:00Z'), now)).toBe('2026-07-19')
    expect(() => resolveCorrectionEntryDate('2026-07-18', new Date('2026-07-18'), now)).toThrow(/serverseitig/)
    expect(() => resolveCorrectionEntryDate(undefined, new Date('2026-07-20'), now)).toThrow(/zukünftiges/)
    expect(resolveCorrectionEntryDate(undefined, new Date('2026-07-19T12:00:00Z'), new Date('2026-07-19T08:00:00Z'))).toBe('2026-07-19')
    expect(resolveCorrectionEntryDate(undefined, new Date('2026-07-18'), new Date('2026-07-20T12:00:00Z'), '2026-07-19')).toBe('2026-07-19')
    expect(() => resolveCorrectionEntryDate('2026-07-20', new Date('2026-07-18'), new Date('2026-07-20T12:00:00Z'), '2026-07-19')).toThrow(/bereits gespeicherten/)
  })
  it('monotonically extends document retention to the authoritative deviating fiscal period', () => {
    expect(documentRetentionExtension(new Date('2026-12-31'), new Date('2035-12-31T23:59:59.999Z'), new Date('2027-03-31T23:59:59.999Z'))).toEqual({
      periodEndsAt: new Date('2027-03-31T23:59:59.999Z'),
      retainUntil: new Date('2035-12-31T23:59:59.999Z'),
    })
    expect(documentRetentionExtension(new Date('2027-03-31T23:59:59.999Z'), new Date('2036-12-31T23:59:59.999Z'), new Date('2026-12-31'))).toBeNull()
  })
})

function posting(documentNumber: string) {
  return { bookingDate: '2026-07-01', documentNumber, description: 'Correction', lines: [
    { accountId: 'cash', debitCents: 100, creditCents: 0 },
    { accountId: 'bank', debitCents: 0, creditCents: 100 },
  ] }
}
