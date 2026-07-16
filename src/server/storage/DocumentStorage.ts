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
      contentDisposition: `inline; filename="${ sanitizeHeaderValue(fileName) }"`,
    })
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

function sanitizeHeaderValue(value: string): string {
  return value.replace(/["\\\r\n]/g, '_')
}
