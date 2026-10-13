import 'server-only'

import type { Prisma } from '@/generated/prisma/client'
import { canonicalJson } from '@/core/compliance/auditExport'
import { getDocumentStorage } from '@/server/storage'
import { sha256 } from './retention'

export function closeEvidenceIds(value: unknown): string[] {
  const ids = new Set<string>()
  const visit = (value: unknown, key = ''): void => {
    if (Array.isArray(value)) {
      if (/evidenceIds$/i.test(key)) { for (const id of value) if (typeof id === 'string' && id.trim()) ids.add(id.trim()) }
      else for (const item of value) visit(item, key)
    } else if (value && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) visit(child, childKey)
    } else if (/evidenceId$/i.test(key) && typeof value === 'string' && value.trim()) ids.add(value.trim())
  }
  visit(value)
  return [...ids].sort()
}

/** Resolve references against live retained bytes, not only database metadata. */
export async function loadVerifiedCloseEvidence(client: Prisma.TransactionClient, ownerId: string, ids: readonly string[]) {
  if (!ids.length) return { evidence: [], missingEvidenceIds: [] }
  const [artifacts, documents] = await Promise.all([
    client.retainedArtifact.findMany({ where: { ownerId, disposedAt: null, storageDeletedAt: null, OR: [{ id: { in: [...ids] } }, { objectType: 'Document', objectId: { in: [...ids] } }] } }),
    client.documentRecord.findMany({ where: { ownerId, id: { in: [...ids] } }, select: { id: true, payload: true } }),
  ])
  const evidence: Array<{ id: string; source: string; contentHash: string }> = []
  const storage = getDocumentStorage()
  for (const id of ids) {
    const document = documents.find(item => item.id === id)
    let storageKey: unknown
    if (document) {
      try { storageKey = (JSON.parse(document.payload) as { storageKey?: unknown })?.storageKey } catch { continue }
    }
    const matches = artifacts.filter(item => document
      ? item.objectType === 'Document' && item.objectId === id && item.storageKey === storageKey
      : item.id === id)
    if (!matches.length || matches.some(item => item.contentHash !== matches[0].contentHash)) continue
    const artifact = matches[0]
    if (!artifact.storageKey || (document && (typeof storageKey !== 'string' || !storageKey))) continue
    try {
      const contentHash = sha256(await storage.read(artifact.storageKey))
      if (contentHash !== artifact.contentHash) continue
      evidence.push({
        id, source: document ? 'DOCUMENT' : 'RETAINED_ARTIFACT',
        contentHash: document ? sha256(canonicalJson({ payload: document.payload, contentHash })) : contentHash,
      })
    } catch { /* Missing/unreadable bytes are unresolved evidence, so the close blocks. */ }
  }
  const resolved = new Set(evidence.map(item => item.id))
  return { evidence, missingEvidenceIds: ids.filter(id => !resolved.has(id)) }
}
