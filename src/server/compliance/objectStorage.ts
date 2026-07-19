import 'server-only'

import { getDocumentStorage } from '@/server/storage'

export async function persistComplianceObject(input: {
  ownerId: string
  category: 'backups' | 'tax-exports' | 'closing-snapshots'
  objectId: string
  extension: 'json' | 'zip'
  content: Uint8Array
  contentType: 'application/json' | 'application/zip'
  fileName: string
}): Promise<string> {
  const storageKey = `${input.category}/${encodeURIComponent(input.ownerId)}/${input.objectId}.${input.extension}`
  await getDocumentStorage().write(storageKey, Buffer.from(input.content), { contentType: input.contentType, fileName: input.fileName })
  return storageKey
}
