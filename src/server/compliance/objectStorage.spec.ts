import { beforeEach, describe, expect, it, vi } from 'vitest'

const write = vi.hoisted(() => vi.fn())
vi.mock('server-only', () => ({}))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({ write }) }))
import { persistComplianceObject } from './objectStorage'

describe('independent compliance object storage', () => {
  beforeEach(() => vi.clearAllMocks())
  it.each([
    ['backups', 'json', 'application/json', 'backup.json'],
    ['tax-exports', 'zip', 'application/zip', 'report.zip'],
    ['closing-snapshots', 'json', 'application/json', 'closing.json'],
  ] as const)('persists %s bytes outside the operational database', async (category, extension, contentType, fileName) => {
    const content = new Uint8Array([1, 2, 3])
    await expect(persistComplianceObject({ ownerId: 'tenant/a', category, objectId: 'object-1', extension, content, contentType, fileName })).resolves.toBe(`${category}/tenant%2Fa/object-1.${extension}`)
    expect(write).toHaveBeenCalledWith(`${category}/tenant%2Fa/object-1.${extension}`, Buffer.from(content), { contentType, fileName })
  })
})
