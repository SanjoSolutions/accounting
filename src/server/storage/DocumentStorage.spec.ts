import { Operator } from 'opendal'
import { describe, expect, it, vi } from 'vitest'
import { DocumentStorage } from './DocumentStorage'

describe('DocumentStorage', () => {
  it('stores, reads and deletes binary documents through OpenDAL', async () => {
    const storage = new DocumentStorage(new Operator('memory'))
    const key = 'documents/example.pdf'
    const content = Buffer.from('%PDF-test')

    await storage.write(key, content, {
      contentType: 'application/pdf',
      fileName: 'example.pdf',
    })

    expect(await storage.exists(key)).toBe(true)
    expect(await storage.read(key)).toEqual(content)

    await storage.delete(key)
    expect(await storage.exists(key)).toBe(false)
  })

  it('atomically creates a document only once', async () => {
    const storage = new DocumentStorage(new Operator('memory'))
    const key = 'documents/content-addressed.pdf'
    const metadata = { contentType: 'application/pdf', fileName: 'evidence.pdf' }

    const created = await Promise.all([
      storage.writeIfAbsent(key, Buffer.from('first'), metadata),
      storage.writeIfAbsent(key, Buffer.from('second'), metadata),
    ])
    expect(created.filter(Boolean)).toHaveLength(1)
    expect(['first', 'second']).toContain((await storage.read(key)).toString())
  })

  it('propagates non-conditional write failures even when the key is visible', async () => {
    const writeFailure = new Error('Unexpected write failure after creating the destination')
    const operator = {
      write: vi.fn(async () => { throw writeFailure }),
      exists: vi.fn(async () => true),
    } as unknown as Operator
    const storage = new DocumentStorage(operator)

    await expect(storage.writeIfAbsent('documents/partial.pdf', Buffer.from('partial'), {
      contentType: 'application/pdf', fileName: 'partial.pdf',
    })).rejects.toBe(writeFailure)
    expect(operator.exists).not.toHaveBeenCalled()
  })
})
