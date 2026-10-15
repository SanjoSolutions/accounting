import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: { $transaction: mocks.transaction } }))
import { reconcileInvoiceNumberSequence } from './structuredInvoices'
import { importedInvoiceNumbersHash } from './operations'

describe('invoice numbering onboarding retries', () => {
  const numbers = ['2026-000040', '2026-000041']
  const evidence = { firstUnusedNumber: 42, importedHighestNumber: 41, importedCount: 2, importedNumbersHash: importedInvoiceNumbersHash(numbers), confirmedBy: 'original-admin' }
  const sequence = { findUnique: vi.fn(), update: vi.fn(), create: vi.fn() }
  const onboarding = { findUnique: vi.fn(), create: vi.fn() }
  const localNumbers = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    sequence.findUnique.mockResolvedValue({ nextValue: 44 })
    onboarding.findUnique.mockResolvedValue(evidence)
    mocks.transaction.mockImplementation(callback => callback({ invoiceNumberSequence: sequence, invoiceNumberSequenceOnboarding: onboarding, structuredInvoice: { findMany: localNumbers } }))
  })

  test('Given a committed reconciliation and later issued numbers, when the same inputs are retried in another order, then the current sequence is returned without rewriting evidence', async () => {
    await expect(reconcileInvoiceNumberSequence('tenant-a', 'retry-admin', 2026, 42, [...numbers].reverse(), true)).resolves.toMatchObject({ ownerId: 'tenant-a', year: 2026, nextValue: 44, importedCount: 2, importedNumbersHash: evidence.importedNumbersHash })
    expect(onboarding.findUnique).toHaveBeenCalledWith({ where: { ownerId_year: { ownerId: 'tenant-a', year: 2026 } } })
    expect(sequence.update).not.toHaveBeenCalled(); expect(sequence.create).not.toHaveBeenCalled(); expect(onboarding.create).not.toHaveBeenCalled(); expect(localNumbers).not.toHaveBeenCalled()
  })

  test('Given a committed reconciliation, when a retry changes its import set, then immutable evidence cannot be overwritten', async () => {
    await expect(reconcileInvoiceNumberSequence('tenant-a', 'retry-admin', 2026, 42, ['2026-000041'], true)).rejects.toThrow(/immutable/)
    expect(sequence.update).not.toHaveBeenCalled(); expect(onboarding.create).not.toHaveBeenCalled()
  })

  test.each([null, { nextValue: 41 }])('Given inconsistent persisted sequence %j, when onboarding is retried, then it fails closed', async value => {
    sequence.findUnique.mockResolvedValue(value)
    await expect(reconcileInvoiceNumberSequence('tenant-a', 'retry-admin', 2026, 42, numbers, true)).rejects.toThrow(/contradicts/)
  })

  test('Given a completed reconciliation whose series is now exhausted, when its result is retried, then no additional number is allocated', async () => {
    sequence.findUnique.mockResolvedValue({ nextValue: 1_000_000 })
    await expect(reconcileInvoiceNumberSequence('tenant-a', 'retry-admin', 2026, 42, numbers, true)).resolves.toMatchObject({ nextValue: 1_000_000 })
    expect(sequence.update).not.toHaveBeenCalled()
  })
})
