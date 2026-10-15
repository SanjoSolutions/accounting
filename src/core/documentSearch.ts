export type DocumentSearchStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'PARTIAL' | 'NEEDS_OCR' | 'FAILED'

export type DocumentSearchState = {
  status: DocumentSearchStatus
  source: string | null
  failureCode: string | null
}

export type DocumentSearchResult = {
  id: string
  url: string
  fileName?: string
  contentType?: string
  thumbnailUrl?: string
  size?: number
  search: DocumentSearchState
  snippet: string | null
}

export type DocumentSearchResponse = {
  documents: DocumentSearchResult[]
  total: number
  pending: number
  processing: number
  retryDocumentIds: string[]
}

/** Shared normalization for names, indexed text and queries, including German sharp s. */
export function normalizeDocumentSearch(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim()
}

export function documentSearchTerms(query: string): string[] {
  if (query.length > 200) throw new RangeError('Search must not exceed 200 characters.')
  return [...new Set(normalizeDocumentSearch(query).split(' ').filter(Boolean))]
}

export function matchDocumentSearch(fileName: string, text: string, terms: string[]) {
  const name = normalizeDocumentSearch(fileName)
  const content = normalizeDocumentSearch(text)
  if (!terms.every(term => name.includes(term) || content.includes(term))) return null
  // Filename matches come first; all terms must occur, even across name and content.
  const score = terms.filter(term => name.includes(term)).length
  const contentTerm = terms.find(term => !name.includes(term)) ?? terms.find(term => content.includes(term))
  const position = contentTerm ? content.indexOf(contentTerm) : -1
  const start = Math.max(0, position - 55)
  const excerpt = position < 0 ? null : content.slice(start, start + 180)
  return { score, snippet: excerpt === null ? null : `${start ? '…' : ''}${excerpt}${content.length > start + 180 ? '…' : ''}` }
}
