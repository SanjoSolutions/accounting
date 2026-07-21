import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn(), findUnique: vi.fn(), transaction: vi.fn() }))

vi.mock('./client', () => ({
  prisma: {
    documentRecord: { findMany: mocks.findMany },
    accountRecord: { findUnique: mocks.findUnique },
    $transaction: mocks.transaction,
  },
}))

import { createPrismaPersistence } from './prisma'

describe('Prisma document repository', () => {
  beforeEach(() => vi.clearAllMocks())

  it('filters documents by indexed owner in the database', async () => {
    mocks.findMany.mockResolvedValueOnce([])

    await createPrismaPersistence().documents.findAllByOwner('owner-1')

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { ownerId: 'owner-1', availableForBooking: true },
      orderBy: { id: 'desc' },
    })
  })

  it('preserves the exact raw settings payload for first-update concurrency after hydration', async () => {
    const raw = '{"id":"company:owner-1","chartOfAccounts":"SKR04"}'
    mocks.findUnique.mockResolvedValueOnce({ id: 'company:owner-1', payload: raw })
    const account = await createPrismaPersistence().accounts.findOne('company:owner-1')
    expect(account?.persistencePayload).toBe(raw)
    expect(JSON.stringify(account)).not.toBe(raw)
  })

  it('refuses to ambiguously assign legacy default settings', async () => {
    mocks.transaction.mockImplementationOnce(async (callback: (client: unknown) => unknown) => callback({
      $executeRaw: vi.fn(),
      accountRecord: { findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'default' }) },
      user: { findMany: vi.fn().mockResolvedValue([{ id: 'owner-1' }, { id: 'owner-2' }]) },
    }))
    await expect(createPrismaPersistence().accounts.claimLegacyDefault('company:owner-1', 'owner-1')).rejects.toThrow(/ambiguous/)
  })

  it('atomically claims the legacy default for the sole credential tenant', async () => {
    const previousOwner = process.env.LEGACY_SETTINGS_OWNER_ID; process.env.LEGACY_SETTINGS_OWNER_ID = 'owner-1'
    const update = vi.fn().mockResolvedValue({ id: 'company:owner-1' })
    mocks.transaction.mockImplementationOnce(async (callback: (client: unknown) => unknown) => callback({
      $executeRaw: vi.fn(),
      accountRecord: { findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'default', payload: JSON.stringify({ id: 'default' }) }), update },
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'owner-1' }) },
    }))
    mocks.findUnique.mockResolvedValueOnce({ id: 'company:owner-1', payload: JSON.stringify({ id: 'company:owner-1' }) })
    await expect(createPrismaPersistence().accounts.claimLegacyDefault('company:owner-1', 'owner-1')).resolves.toMatchObject({ id: 'company:owner-1' })
    expect(update).toHaveBeenCalledWith({ where: { id: 'default' }, data: { id: 'company:owner-1', ownerId: 'owner-1', payload: JSON.stringify({ id: 'company:owner-1' }) } })
    if (previousOwner === undefined) delete process.env.LEGACY_SETTINGS_OWNER_ID; else process.env.LEGACY_SETTINGS_OWNER_ID = previousOwner
  })

  it('allows an operator-mapped legacy claim among multiple tenants', async () => {
    const previous = process.env.LEGACY_SETTINGS_OWNER_ID; process.env.LEGACY_SETTINGS_OWNER_ID = 'owner-1'
    const update = vi.fn().mockResolvedValue({ id: 'company:owner-1' })
    const findUniqueOwner = vi.fn().mockResolvedValue({ id: 'owner-1' })
    mocks.transaction.mockImplementationOnce(async (callback: (client: unknown) => unknown) => callback({ $executeRaw: vi.fn(), accountRecord: { findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'default', payload: '{"id":"default"}' }), update }, user: { findUnique: findUniqueOwner } }))
    mocks.findUnique.mockResolvedValueOnce({ id: 'company:owner-1', payload: '{"id":"company:owner-1"}' })
    await expect(createPrismaPersistence().accounts.claimLegacyDefault('company:owner-1', 'owner-1')).resolves.toMatchObject({ id: 'company:owner-1' })
    expect(findUniqueOwner).toHaveBeenCalledWith({ where: { id: 'owner-1' }, select: { id: true } })
    if (previous === undefined) delete process.env.LEGACY_SETTINGS_OWNER_ID; else process.env.LEGACY_SETTINGS_OWNER_ID = previous
  })

  it('treats local as a real configured tenant id in credentials mode', async () => {
    const previousOwner = process.env.LEGACY_SETTINGS_OWNER_ID
    const previousMode = process.env.AUTH_MODE
    process.env.LEGACY_SETTINGS_OWNER_ID = 'local'
    process.env.AUTH_MODE = 'credentials'
    const update = vi.fn().mockResolvedValue({ id: 'company:local' })
    const findUniqueOwner = vi.fn().mockResolvedValue({ id: 'local' })
    try {
      mocks.transaction.mockImplementationOnce(async (callback: (client: unknown) => unknown) => callback({ $executeRaw: vi.fn(), accountRecord: { findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'default', payload: '{"id":"default"}' }), update }, user: { findUnique: findUniqueOwner, count: vi.fn() } }))
      mocks.findUnique.mockResolvedValueOnce({ id: 'company:local', payload: '{"id":"company:local"}' })
      await expect(createPrismaPersistence().accounts.claimLegacyDefault('company:local', 'local')).resolves.toMatchObject({ id: 'company:local' })
      expect(findUniqueOwner).toHaveBeenCalledWith({ where: { id: 'local' }, select: { id: true } })
    } finally {
      if (previousOwner === undefined) delete process.env.LEGACY_SETTINGS_OWNER_ID; else process.env.LEGACY_SETTINGS_OWNER_ID = previousOwner
      if (previousMode === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previousMode
    }
  })
})
