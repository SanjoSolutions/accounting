import type { Operator } from 'opendal'

export interface StoredDocument {
  content: Buffer
  contentType: string
  fileName: string
}

export class DocumentStorage {
  constructor(private readonly operator: Operator) {}

  async write(
    key: string,
    content: Buffer,
    { contentType, fileName }: Omit<StoredDocument, 'content'>,
  ): Promise<void> {
    await this.operator.write(key, content, {
      contentType,
      contentDisposition: storageContentDisposition(contentType, fileName),
    })
  }

  async writeIfAbsent(
    key: string,
    content: Buffer,
    { contentType, fileName }: Omit<StoredDocument, 'content'>,
  ): Promise<boolean> {
    try {
      await this.operator.write(key, content, {
        contentType,
        contentDisposition: storageContentDisposition(contentType, fileName),
        ifNotExists: true,
      })
      return true
    } catch (error) {
      if (isConditionNotMatch(error)) return false
      throw error
    }
  }

  async read(key: string): Promise<Buffer> {
    return this.operator.read(key)
  }

  async delete(key: string): Promise<void> {
    await this.operator.delete(key)
  }

  async exists(key: string): Promise<boolean> {
    return this.operator.exists(key)
  }
}

function isConditionNotMatch(error: unknown) {
  return error instanceof Error && error.message.startsWith('ConditionNotMatch ')
}

function storageContentDisposition(contentType: string, fileName: string) {
  const inlineTypes = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/bmp', 'image/tiff', 'image/webp'])
  const disposition = inlineTypes.has(contentType.toLowerCase()) ? 'inline' : 'attachment'
  return `${disposition}; filename="${sanitizeHeaderValue(fileName)}"`
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, '_')
}
