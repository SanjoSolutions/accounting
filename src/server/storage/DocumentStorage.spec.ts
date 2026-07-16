import { Operator } from 'opendal'
import { describe, expect, it } from 'vitest'
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
})
