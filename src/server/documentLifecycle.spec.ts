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
  registerRetainedArtifact: vi.fn(),
  fiscalPeriod: vi.fn(),
  deleteRecord: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('./documentThumbnail', () => ({ generateDocumentThumbnail: mocks.generateDocumentThumbnail }))
vi.mock('./persistence/client', () => ({ prisma: {
  fiscalYear: { findFirst: mocks.fiscalPeriod },
  documentRecord: { deleteMany: mocks.deleteRecord },
} }))
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
vi.mock('./compliance/runtime', () => ({ registerRetainedArtifact: mocks.registerRetainedArtifact }))

import { createDocument, readDocumentThumbnail } from './index'

describe('document thumbnail lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.delete.mockResolvedValue(undefined)
    mocks.generateDocumentThumbnail.mockResolvedValue(Buffer.from('webp'))
    mocks.write.mockResolvedValue(undefined)
    mocks.save.mockResolvedValue(undefined)
    mocks.registerRetainedArtifact.mockResolvedValue({ id: 'artifact-1' })
    mocks.fiscalPeriod.mockResolvedValue({ endsAt: new Date('2027-03-31T23:59:59.999Z') })
    mocks.deleteRecord.mockResolvedValue({ count: 0 })
  })

  it('stores one generated thumbnail and returns only its authenticated URL', async () => {
    const document = await createDocument(pdfInput(), 'owner-1')

    expect(mocks.generateDocumentThumbnail).toHaveBeenCalledOnce()
    expect(mocks.write).toHaveBeenCalledTimes(2)
    const storedDocument = mocks.save.mock.calls[0][0] as Document
    expect(mocks.write.mock.calls[0][0]).toBe(`documents/owner-1/${storedDocument.id}.pdf`)
    expect(mocks.write.mock.calls[0][2]).toMatchObject({ fileName: `${storedDocument.id}.pdf` })
    expect(mocks.write.mock.calls[1][0]).toMatch(/^documents\/owner-1\/.+\.webp$/)
    expect(mocks.write.mock.calls[1][2]).toMatchObject({ fileName: `${storedDocument.id}.webp` })
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: 'owner-1',
      fileName: 'invoice.pdf',
      thumbnailStorageKey: expect.stringMatching(/\.webp$/),
    }))
    expect(mocks.registerRetainedArtifact).toHaveBeenCalledWith('owner-1', 'owner-1', expect.objectContaining({ objectType: 'Document', retentionClass: 'INVOICE', content: expect.any(Buffer) }))
    expect(mocks.registerRetainedArtifact).toHaveBeenCalledWith('owner-1', 'owner-1', expect.objectContaining({ periodEndsAt: '2027-03-31' }))
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

  it('assigns a unique ID filename to every upload while preserving its original display name', async () => {
    await createDocument(pdfInput(), 'owner-1')
    await createDocument(pdfInput(), 'owner-1')

    const [first, second] = mocks.save.mock.calls.map(call => call[0] as Document)
    expect(first.id).not.toBe(second.id)
    expect(first.fileName).toBe('invoice.pdf')
    expect(second.fileName).toBe('invoice.pdf')
    expect(mocks.write.mock.calls[0][0]).toBe(`documents/owner-1/${first.id}.pdf`)
    expect(mocks.write.mock.calls[2][0]).toBe(`documents/owner-1/${second.id}.pdf`)
  })

  it('uses a conservative next-year retention boundary before fiscal-period assignment', async () => {
    mocks.fiscalPeriod.mockResolvedValueOnce(null)
    await createDocument(pdfInput(), 'owner-1')
    expect(mocks.registerRetainedArtifact).toHaveBeenCalledWith('owner-1', 'owner-1', expect.objectContaining({ periodEndsAt: `${new Date().getUTCFullYear() + 1}-12-31` }))
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

  it('preserves document bytes when retention fails and the persisted row cannot be rolled back', async () => {
    mocks.registerRetainedArtifact.mockRejectedValueOnce(new Error('retention unavailable'))
    mocks.deleteRecord.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(createDocument(pdfInput(), 'owner-1')).rejects.toThrow(/storage objects were preserved/)
    expect(mocks.delete).not.toHaveBeenCalled()
  })
})

function pdfInput() {
  return {
    content: Buffer.from('%PDF-test'),
    contentType: 'application/pdf',
    fileName: 'invoice.pdf',
  }
}
