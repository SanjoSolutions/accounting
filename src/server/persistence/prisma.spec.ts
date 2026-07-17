import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }))

vi.mock('./client', () => ({
  prisma: {
    documentRecord: { findMany: mocks.findMany },
  },
}))

import { createPrismaPersistence } from './prisma'

describe('Prisma document repository', () => {
  beforeEach(() => vi.clearAllMocks())

  it('filters documents by indexed owner in the database', async () => {
    mocks.findMany.mockResolvedValueOnce([])

    await createPrismaPersistence().documents.findAllByOwner('owner-1')

    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { ownerId: 'owner-1' },
      orderBy: { id: 'desc' },
    })
  })
})
