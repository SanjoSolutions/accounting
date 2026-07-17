import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Document } from '@/core/Document'

const mocks = vi.hoisted(() => ({
  delete: vi.fn(),
  exists: vi.fn(),
  findAllByOwner: vi.fn(),
  findOne: vi.fn(),
  generateDocumentThumbnail: vi.fn(),
  read: vi.fn(),
  save: vi.fn(),
  write: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('./documentThumbnail', () => ({ generateDocumentThumbnail: mocks.generateDocumentThumbnail }))
vi.mock('./persistence/prisma', () => ({
  createPrismaPersistence: () => ({
    accounts: { findOne: vi.fn(), save: vi.fn() },
    bookingRecords: { save: vi.fn() },
    documents: {
      findAllByOwner: mocks.findAllByOwner,
      findOne: mocks.findOne,
      save: mocks.save,
    },
  }),
}))
vi.mock('./storage', () => ({
  getDocumentStorage: () => ({
    delete: mocks.delete,
    exists: mocks.exists,
    read: mocks.read,
    write: mocks.write,
  }),
}))

import { createDocument, readDocumentThumbnail } from './index'

describe('document thumbnail lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.delete.mockResolvedValue(undefined)
    mocks.generateDocumentThumbnail.mockResolvedValue(Buffer.from('webp'))
    mocks.write.mockResolvedValue(undefined)
    mocks.save.mockResolvedValue(undefined)
  })

  it('stores one generated thumbnail and returns only its authenticated URL', async () => {
    const document = await createDocument(pdfInput(), 'owner-1')

    expect(mocks.generateDocumentThumbnail).toHaveBeenCalledOnce()
    expect(mocks.write).toHaveBeenCalledTimes(2)
    expect(mocks.write.mock.calls[1][0]).toMatch(/^documents\/owner-1\/.+\.webp$/)
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'owner-1',
      thumbnailStorageKey: expect.stringMatching(/\.webp$/),
    }))
    expect(document.thumbnailUrl).toMatch(/^\/api\/documents\/.+\/thumbnail$/)
    expect(document.storageKey).toBeUndefined()
    expect(document.thumbnailStorageKey).toBeUndefined()
    expect(document.ownerId).toBeUndefined()
  })

  it('keeps a valid upload when thumbnail generation is unavailable', async () => {
    mocks.generateDocumentThumbnail.mockRejectedValueOnce(new Error('renderer unavailable'))

    const document = await createDocument(pdfInput(), 'owner-1')

    expect(document.thumbnailUrl).toBeUndefined()
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ thumbnailStorageKey: undefined }))
    expect(mocks.delete).toHaveBeenCalledWith(expect.stringMatching(/\.webp$/))
  })

  it('reads a stored thumbnail only for its owner', async () => {
    mocks.findOne.mockResolvedValueOnce(new Document(
      'document-1',
      '/file',
      'document.pdf',
      'invoice.pdf',
      'application/pdf',
      10,
      'owner-1',
      'document.webp',
    ))
    mocks.exists.mockResolvedValueOnce(true)
    mocks.read.mockResolvedValueOnce(Buffer.from('webp'))

    await expect(readDocumentThumbnail('document-1', 'owner-1')).resolves.toEqual({
      content: Buffer.from('webp'),
      contentType: 'image/webp',
    })
    expect(mocks.read).toHaveBeenCalledWith('document.webp')
  })
})

function pdfInput() {
  return {
    content: Buffer.from('%PDF-test'),
    contentType: 'application/pdf',
    fileName: 'invoice.pdf',
  }
}
