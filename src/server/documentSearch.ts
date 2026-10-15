import 'server-only'

import { createHash, randomUUID } from 'node:crypto'
import { prisma } from './persistence/client'
import { readDocumentFile } from './index'
import { extractDocumentSearchText, SearchTextError, searchIndexTimeoutMs, type SearchTextExtractor } from './documentSearchText'
import { documentSearchTerms, matchDocumentSearch, normalizeDocumentSearch, type DocumentSearchResponse, type DocumentSearchResult, type DocumentSearchState } from '@/core/documentSearch'
import type { Document } from '@/core/Document'

export class DocumentSearchError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function searchDocuments(ownerId: string, query = '', offset = 0, scope: 'available' | 'all' = 'available'): Promise<DocumentSearchResponse> {
  const terms = documentSearchTerms(query)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Invalid search offset.')
  const records = await prisma.documentRecord.findMany({
    where: { ownerId, ...(scope === 'available' ? { availableForBooking: true } : {}) },
    include: { searchIndex: true },
    orderBy: { id: 'desc' },
  })
  const matches: (DocumentSearchResult & { score: number })[] = []
  const retryCandidates: { id: string; priority: number; updatedAt: number }[] = []
  let pending = 0
  let processing = 0
  for (const record of records) {
    const document = JSON.parse(record.payload) as Document
    const index = record.searchIndex
    // A stale worker never makes the library permanently unsearchable/retry-proof.
    const search = publicSearchState(index)
    if (search.status === 'PROCESSING') processing++
    else if (search.status !== 'READY') {
      pending++
      retryCandidates.push({ id: record.id, priority: search.status === 'PENDING' ? 0 : 1, updatedAt: index?.updatedAt.getTime() ?? 0 })
    }
    const match = matchDocumentSearch(document.fileName ?? '', index?.text ?? '', terms)
    if (!match) continue
    matches.push({
      id: record.id, url: `/api/documents/${encodeURIComponent(record.id)}/file`, fileName: document.fileName,
      contentType: document.contentType, size: document.size,
      thumbnailUrl: document.thumbnailStorageKey ? `/api/documents/${encodeURIComponent(record.id)}/thumbnail` : undefined,
      search, ...match,
    })
  }
  matches.sort((a, b) => b.score - a.score || b.id.localeCompare(a.id))
  // Older failures rotate behind freshly attempted ones, so an OCR/configuration
  // failure cannot indefinitely starve other legacy files in the next batch.
  retryCandidates.sort((a, b) => a.priority - b.priority || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
  return { documents: matches.slice(offset, offset + 50).map(({ score: _score, ...result }) => result), total: matches.length, pending, processing, retryDocumentIds: retryCandidates.slice(0, 20).map(item => item.id) }
}

export async function indexDocumentSearch(ownerId: string, documentId: string, extract: SearchTextExtractor = extractDocumentSearchText): Promise<DocumentSearchState> {
  // Ownership is checked before any storage read, worker launch or index mutation.
  const document = await prisma.documentRecord.findFirst({ where: { id: documentId, ownerId }, select: { id: true } })
  if (!document) throw new DocumentSearchError('Document not found.', 404)
  const attemptId = randomUUID()
  const now = new Date()
  const leaseUntil = new Date(now.getTime() + searchIndexTimeoutMs + 30_000)
  const claim = await prisma.$transaction(async transaction => {
    await transaction.documentSearchIndex.upsert({ where: { documentId }, create: { documentId, ownerId, status: 'PENDING' }, update: {} })
    const claimed = await transaction.documentSearchIndex.updateMany({
      where: { documentId, ownerId, OR: [{ status: { notIn: ['PROCESSING', 'READY'] } }, { status: 'PROCESSING', leaseUntil: { lte: now } }, { status: 'PROCESSING', leaseUntil: null }] },
      data: { status: 'PROCESSING', attemptId, leaseUntil, failureCode: null },
    })
    return { claimed: claimed.count === 1, current: await transaction.documentSearchIndex.findUniqueOrThrow({ where: { documentId } }) }
  })
  if (!claim.claimed) return publicSearchState(claim.current)
  try {
    const file = await readDocumentFile(documentId, ownerId)
    if (!file) throw new SearchTextError('FILE_UNAVAILABLE')
    const result = await extract(file)
    if (result.text.length > 500_000) throw new SearchTextError('TEXT_LIMIT')
    await prisma.documentSearchIndex.updateMany({ where: { documentId, ownerId, attemptId, status: 'PROCESSING' }, data: {
      text: normalizeDocumentSearch(result.text), status: result.status, source: result.source,
      inputHash: createHash('sha256').update(file.content).digest('hex'), failureCode: result.failureCode,
      attemptId: null, leaseUntil: null,
    } })
  } catch (error) {
    await prisma.documentSearchIndex.updateMany({ where: { documentId, ownerId, attemptId, status: 'PROCESSING' }, data: {
      status: 'FAILED', failureCode: error instanceof SearchTextError ? error.message : 'PARSER_FAILURE', attemptId: null, leaseUntil: null,
    } })
  }
  return publicSearchState(await prisma.documentSearchIndex.findUniqueOrThrow({ where: { documentId } }))
}

function publicSearchState(index: { status: string; source: string | null; failureCode: string | null; leaseUntil: Date | null } | null): DocumentSearchState {
  if (!index) return { status: 'PENDING', source: null, failureCode: null }
  const expired = index.status === 'PROCESSING' && (!index.leaseUntil || index.leaseUntil.getTime() <= Date.now())
  return { status: expired ? 'FAILED' : index.status as DocumentSearchState['status'], source: index.source, failureCode: expired ? 'INTERRUPTED' : index.failureCode }
}
