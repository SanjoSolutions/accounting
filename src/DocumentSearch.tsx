'use client'

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { DocumentSearchResponse, DocumentSearchResult } from './core/documentSearch'

/** Search results are separate from attachment state, so filtering never detaches a document. */
export function DocumentSearch({ revision, onDocuments, children }: {
  revision: number
  onDocuments: (documents: DocumentSearchResult[]) => void
  children: (documents: DocumentSearchResult[], searching: boolean) => ReactNode
}) {
  const t = useTranslations('DocumentSearch')
  const id = useId()
  const [query, setQuery] = useState('')
  const [data, setData] = useState<DocumentSearchResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [indexing, setIndexing] = useState(false)
  const [error, setError] = useState('')
  const [indexError, setIndexError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const request = useRef<AbortController | null>(null)
  const generation = useRef(0)
  const indexingRef = useRef(false)
  const previousQuery = useRef(query)

  const load = useCallback(async (offset = 0, expectedGeneration = generation.current) => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/documents/search?${new URLSearchParams({ q: query, offset: String(offset) })}`, { signal: controller.signal })
      if (!response.ok) throw new Error()
      const body = await response.json()
      if (controller.signal.aborted || expectedGeneration !== generation.current) return
      const result = body.data as DocumentSearchResponse
      setData(current => ({ ...result, documents: offset && current ? [...current.documents, ...result.documents] : result.documents }))
      onDocuments(result.documents)
    } catch {
      if (!controller.signal.aborted && expectedGeneration === generation.current) setError(t('loadFailed'))
    } finally {
      if (!controller.signal.aborted && expectedGeneration === generation.current) setLoading(false)
    }
  }, [onDocuments, query, t])

  useEffect(() => {
    const current = ++generation.current
    setLoading(true)
    if (previousQuery.current !== query) setData(null)
    previousQuery.current = query
    const timer = setTimeout(() => void load(0, current), 200)
    return () => { clearTimeout(timer); request.current?.abort() }
  }, [load, revision, refresh])

  useEffect(() => {
    if (!data?.processing) return
    const timer = setTimeout(() => setRefresh(value => value + 1), 2000)
    return () => clearTimeout(timer)
  }, [data])

  async function indexPending() {
    if (indexingRef.current || !data) return
    indexingRef.current = true
    setIndexing(true)
    setIndexError('')
    try {
      for (const documentId of data.retryDocumentIds) {
        const response = await fetch(`/api/documents/${encodeURIComponent(documentId)}/search-index`, { method: 'POST' })
        if (!response.ok) throw new Error()
      }
    } catch { setIndexError(t('indexFailed')) }
    finally { indexingRef.current = false; setIndexing(false); setRefresh(value => value + 1) }
  }

  return <div className="document-search">
    <label className="form-label" htmlFor={id}>{t('label')}</label>
    <div className="input-group mb-2">
      <input id={id} className="form-control" type="search" maxLength={200} placeholder={t('placeholder')} value={query} onChange={event => setQuery(event.target.value)} aria-describedby={`${id}-help`} />
      {query && <button className="btn btn-outline-secondary" type="button" onClick={() => setQuery('')}>{t('clear')}</button>}
    </div>
    <p id={`${id}-help`} className="small text-muted mb-2">{t('help')}</p>
    <div className="d-flex flex-wrap align-items-center gap-2 mb-3">
      <span className="small text-muted" role="status">{loading ? t(data ? 'refreshing' : 'loading') : data ? t('count', { count: data.total }) : ''}</span>
      {Boolean(data?.pending) && <>
        <span className="small text-muted">{t('pending', { count: data!.pending })}</span>
        <button type="button" className="btn btn-sm btn-outline-secondary" disabled={indexing} onClick={() => void indexPending()}>{indexing ? t('indexing') : t('index')}</button>
      </>}
      {Boolean(data?.processing) && <span className="small text-muted">{t('indexing')}</span>}
    </div>
    {error && <div className="alert alert-danger" role="alert">{error} <button className="btn btn-sm btn-outline-danger" type="button" onClick={() => setRefresh(value => value + 1)}>{t('retry')}</button></div>}
    {indexError && <div className="alert alert-danger" role="alert">{indexError}</div>}
    <div aria-busy={loading}>
      {data && children(data.documents, Boolean(query.trim()))}
      {!loading && data && data.documents.length < data.total && <button className="btn btn-sm btn-outline-secondary mt-2" type="button" onClick={() => void load(data.documents.length)}>{t('more')}</button>}
    </div>
  </div>
}

export function DocumentSearchDetails({ document }: { document: DocumentSearchResult }) {
  const t = useTranslations('DocumentSearch')
  return <div className="small text-muted mt-1">
    <span>{t(document.search.status)}</span>
    {document.search.status === 'READY' && document.search.source === 'OCR' && <span> · OCR</span>}
    {document.snippet && <p className="mt-1 mb-0 text-break">{document.snippet}</p>}
  </div>
}
