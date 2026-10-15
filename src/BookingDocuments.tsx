"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { api, getJSON } from './Requester'
import { DocumentExtractionPanel } from './DocumentExtractionPanel'
import { LocalCount } from './LocalNumber'
import { DocumentSearch, DocumentSearchDetails } from './DocumentSearch'
import type { DocumentSearchResult } from './core/documentSearch'

export type BookingDocument = {
  id: string
  url: string
  fileName?: string
  contentType?: string
  size?: number
  thumbnailUrl?: string
}

type DocumentKind = 'pdf' | 'xml' | 'generic'

/**
 * Select the icon used when a document has no usable thumbnail.
 *
 * Stored metadata is not always complete (older documents may only have a
 * filename), so a recognized MIME type takes precedence and the filename
 * extension is used as a fallback. Both values are normalized before they
 * are inspected to handle casing and MIME parameters consistently.
 */
export function documentIconClass(document: Pick<BookingDocument, 'contentType' | 'fileName'>): string {
  const kind = documentKind(document)
  if (kind === 'pdf') return 'bi bi-file-earmark-pdf'
  if (kind === 'xml') return 'bi bi-file-earmark-code'
  return 'bi bi-file-earmark'
}

function documentKind(document: Pick<BookingDocument, 'contentType' | 'fileName'>): DocumentKind {
  const contentType = document.contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType === 'application/xml' || contentType === 'text/xml' || contentType?.endsWith('+xml')) return 'xml'

  const extension = document.fileName?.trim().match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase()
  if (extension === 'pdf') return 'pdf'
  if (extension === 'xml') return 'xml'
  return 'generic'
}

function DocumentThumbnail({ document }: { document: BookingDocument }) {
  const [thumbnailFailed, setThumbnailFailed] = useState(false)

  return <span className="document-thumbnail" aria-hidden="true">
    {document.thumbnailUrl && !thumbnailFailed
      ? <img src={document.thumbnailUrl} alt="" loading="lazy" onError={() => setThumbnailFailed(true)} />
      : <i className={documentIconClass(document)} />}
  </span>
}

export type BookingDocumentsRenderContext = {
  /** The compact attached-document region, ready to place inside the editor. */
  attachedDocuments: ReactNode
  /** Whether the full document picker and preview are currently visible. */
  pickerOpen: boolean
}

export type BookingDocumentsChildren = ReactNode | ((context: BookingDocumentsRenderContext) => ReactNode)

const documentColumnStorageKey = 'accounting.bookings.document-column-percent'

export function BookingDocuments({
  selectedDocumentIds,
  unavailableDocumentIds = [],
  initialDocuments = [],
  compactByDefault = false,
  onSelectionChange,
  onUploadingChange,
  onRemoveDocument,
  children,
}: {
  selectedDocumentIds: string[]
  unavailableDocumentIds?: string[]
  /**
   * Metadata returned with an editable draft. The library request is still
   * authoritative, but keeping this list makes attached documents visible
   * while the library is loading and for legacy records without a full URL.
   */
  initialDocuments?: BookingDocument[]
  /**
   * Render only the attached-document list until the user explicitly starts
   * the add flow. The full picker and preview remain available after that.
   */
  compactByDefault?: boolean
  onSelectionChange: (ids: string[]) => void
  onUploadingChange: (uploading: boolean) => void
  onRemoveDocument?: (id: string) => void
  children: BookingDocumentsChildren
}) {
  const t = useTranslations('Workspaces')
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const uploadingRef = useRef(false)
  const selectedDocumentIdsRef = useRef(selectedDocumentIds)
  selectedDocumentIdsRef.current = selectedDocumentIds
  const [documents, setDocuments] = useState<BookingDocument[]>(() => initialDocuments)
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [searchRevision, setSearchRevision] = useState(0)
  const rememberSearchDocuments = useCallback((results: DocumentSearchResult[]) => {
    setDocuments(current => mergeDocumentLists(current, results))
  }, [])
  const [documentColumnPercent, setDocumentColumnPercent] = useState(60)
  const [addFlowOpen, setAddFlowOpen] = useState(!compactByDefault)
  const pickerOpen = documentPickerIsOpen(compactByDefault, addFlowOpen)

  useEffect(() => {
    if (initialDocuments.length) setDocuments(current => mergeDocumentLists(current, initialDocuments))
  }, [initialDocuments])

  useEffect(() => {
    const saved = parseSavedDocumentColumnPercent(window.localStorage.getItem(documentColumnStorageKey))
    if (saved !== null) setDocumentColumnPercent(saved)
  }, [])

  useEffect(() => {
    if (!pickerOpen) return
    const controller = new AbortController()
    void fetch('/api/documents', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error()
        const body = await response.json()
        setDocuments(current => mergeDocumentLists(current, body.data ?? []))
      })
      .catch(fetchError => {
        if (fetchError?.name !== 'AbortError') setError(t('documentsLoadFailed'))
      })
    return () => controller.abort()
  }, [pickerOpen, t])

  const upload = useCallback(async (fileList: ArrayLike<File>) => {
    if (uploadingRef.current || (compactByDefault && !addFlowOpen)) return
    const files = acceptedBookingDocumentFiles(fileList)
    if (!files.length) { setError(t('pdfOnly')); return }
    uploadingRef.current = true
    setUploading(true)
    onUploadingChange(true)
    setError('')
    let uploadedAny = false
    try {
      for (const file of files) {
        const response = await api.postFile('/api/documents', file)
        const uploadedDocument = await readDocumentUploadResponse(response, t('documentUploadFailed'))
        setDocuments(current => mergeUploadedDocument(current, uploadedDocument))
        uploadedAny = true
        const nextSelection = mergeDocumentSelection(selectedDocumentIdsRef.current, uploadedDocument.id)
        selectedDocumentIdsRef.current = nextSelection
        onSelectionChange(nextSelection)
        setActiveDocumentId(current => current ?? uploadedDocument.id)
      }
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t('documentUploadFailed'))
    } finally {
      uploadingRef.current = false
      setUploading(false)
      onUploadingChange(false)
      if (inputRef.current) inputRef.current.value = ''
      if (compactByDefault && uploadedAny) setAddFlowOpen(documentPickerOpenAfterAddition(compactByDefault))
      if (uploadedAny) setSearchRevision(value => value + 1)
    }
  }, [addFlowOpen, compactByDefault, onSelectionChange, onUploadingChange, t])

  useEffect(() => {
    if (!pickerOpen) return
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }
    const over = (event: DragEvent) => { if (hasFiles(event)) event.preventDefault() }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      if (event.dataTransfer?.files.length) void upload(event.dataTransfer.files)
    }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    return () => {
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
    }
  }, [pickerOpen, upload])

  useEffect(() => {
    if (pickerOpen) return
    dragDepth.current = 0
    setDragging(false)
  }, [pickerOpen])

  const attachedDocuments = useMemo(
    () => attachedBookingDocuments(selectedDocumentIds, documents),
    [documents, selectedDocumentIds],
  )
  const selectedDocuments = useMemo(
    () => compactByDefault
      ? attachedDocuments
      : selectedDocumentIds.flatMap(id => documents.find(document => document.id === id) ?? []),
    [attachedDocuments, compactByDefault, documents, selectedDocumentIds],
  )
  const unavailableDocumentIdSet = useMemo(() => new Set(unavailableDocumentIds), [unavailableDocumentIds])
  const activeDocument = selectedDocuments.find(document => document.id === activeDocumentId) ?? selectedDocuments[0]
  const activeDocumentName = activeDocument
    ? documentDisplayName(activeDocument.fileName || t('unnamedDocument'), t('unnamedDocument'))
    : t('unnamedDocument')

  function select(documentId: string, extendSelection: boolean) {
    const isNewAttachment = compactByDefault && !selectedDocumentIds.includes(documentId)
    const next = compactByDefault
      ? addDocumentSelection(selectedDocumentIds, documentId)
      : selectDocument(selectedDocumentIds, documentId, extendSelection)
    onSelectionChange(next)
    if (next.includes(documentId)) setActiveDocumentId(documentId)
    else if (activeDocumentId === documentId) setActiveDocumentId(next[0] ?? null)
    if (isNewAttachment) setAddFlowOpen(documentPickerOpenAfterAddition(compactByDefault))
  }

  function resizeColumns(event: React.PointerEvent<HTMLDivElement>) {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const bounds = event.currentTarget.parentElement!.getBoundingClientRect()
    updateDocumentColumnPercent((event.clientX - bounds.left) / bounds.width * 100)
  }

  function resizeColumnsWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    const change = event.key === 'ArrowLeft' ? -5 : event.key === 'ArrowRight' ? 5 : 0
    if (!change && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const container = event.currentTarget.parentElement!
    const preview = container.querySelector<HTMLElement>('.document-preview-panel')!
    const renderedPercent = preview.getBoundingClientRect().width / container.getBoundingClientRect().width * 100
    updateDocumentColumnPercent(event.key === 'Home' ? 40 : event.key === 'End' ? 75 : renderedPercent + change)
  }

  function updateDocumentColumnPercent(percent: number) {
    const next = clampDocumentColumnPercent(percent)
    setDocumentColumnPercent(next)
    window.localStorage.setItem(documentColumnStorageKey, String(next))
  }

  const pickerPanel = <section className="card panel document-picker-panel">
      <div className="panel-title">
        <h2>{t('documents')}</h2>
        <div className="document-actions">
          <button className="btn btn-outline-secondary" type="button" disabled={uploading} onClick={() => inputRef.current?.click()}>
            <i className="bi bi-plus-lg" aria-hidden="true" /> {uploading ? t('uploadingDocuments') : t('chooseDocuments')}
          </button>
          {compactByDefault && <button className="btn btn-link" type="button" disabled={uploading} onClick={() => setAddFlowOpen(false)}>{t('cancelAddDocument')}</button>}
          <input ref={inputRef} className="visually-hidden" type="file" accept="application/pdf,application/xml,text/xml,.pdf,.xml" multiple onChange={event => event.target.files && void upload(event.target.files)} />
        </div>
      </div>
      {error && <div className="alert alert-danger" role="alert">{error}</div>}
      <DocumentSearch revision={searchRevision} onDocuments={rememberSearchDocuments}>{(results, searching) => {
        const visibleDocuments = availableBookingDocuments(results, unavailableDocumentIdSet)
          .filter(document => !compactByDefault || !selectedDocumentIds.includes(document.id))
        return visibleDocuments.length === 0 && !uploading
        ? results.length ? <p className="text-muted">{t('noAvailableSearchDocuments')}</p>
          : searching ? <p className="text-muted">{t('noSearchDocuments')}</p>
          : <button type="button" className="document-empty btn btn-outline-secondary w-100" onClick={() => inputRef.current?.click()}><i className="bi bi-file-earmark-arrow-up" aria-hidden="true" /><strong>{t('noDocuments')}</strong><span>{t('noDocumentsHelp')}</span></button>
        : <div className="document-strip" role="list" aria-label={t('availableDocuments')}>{visibleDocuments.map(document => {
          const selected = selectedDocumentIds.includes(document.id)
          return <div key={document.id} className="document-search-result" role="listitem"><DocumentCard
            document={document}
            selected={selected}
            fallbackName={t('unnamedDocument')}
            onSelect={extendSelection => select(document.id, extendSelection)}
          /><DocumentSearchDetails document={results.find(result => result.id === document.id)!} /></div>
        })}</div>
      }}</DocumentSearch>
    </section>

  const attachedDocumentsRegion = <section className="attached-documents-region border-top mt-4 pt-4" aria-label={t('attachedDocuments')}>
      <div className="panel-title">
        <h2>{t('attachedDocuments')}</h2>
        <span className="badge text-bg-light hint"><LocalCount value={attachedDocuments.length} /></span>
      </div>
      {attachedDocuments.length === 0
        ? <div className="preview-empty attached-documents-empty"><i className="bi bi-paperclip" aria-hidden="true" /><strong>{t('noSelectedDocuments')}</strong><p>{t('noSelectedDocumentsHelp')}</p></div>
        : <div className="attached-document-list" role="list" aria-label={t('attachedDocuments')}>{attachedDocuments.map(document => {
          const name = documentDisplayName(document.fileName || t('unnamedDocument'), t('unnamedDocument'))
          return <AttachedDocumentRow
            key={document.id}
            document={document}
            fallbackName={t('unnamedDocument')}
            openLabel={t('openDocument')}
            removeLabel={t('removeDocumentAction')}
            removeAccessibleLabel={t('removeDocument', { name })}
            onRemove={onRemoveDocument ? () => onRemoveDocument(document.id) : undefined}
          />
        })}</div>}
      <div className="document-actions attached-documents-actions">
        <button className="btn btn-primary" type="button" onClick={() => setAddFlowOpen(true)}>
          <i className="bi bi-plus-lg me-1" aria-hidden="true" />{t('addDocument')}
        </button>
      </div>
    </section>

  const renderChildren = () => typeof children === 'function'
    ? children({ attachedDocuments: attachedDocumentsRegion, pickerOpen })
    : children

  return <>
    {pickerOpen && dragging && <div className="viewport-drop-target" role="status"><div><i className="bi bi-cloud-arrow-up" aria-hidden="true" /><strong>{t('dropDocuments')}</strong><span>{t('dropDocumentsHelp')}</span></div></div>}
    {compactByDefault && !pickerOpen ? null : pickerPanel}

    {!pickerOpen ? <div className="booking-workflow-columns booking-workflow-columns--compact">{renderChildren()}</div> : <div className="booking-workflow-columns" style={{ '--document-column': `${documentColumnPercent}%` } as React.CSSProperties}>
    <section className="card panel document-preview-panel">
      <div className="panel-title"><h2>{t('documentPreview')}</h2><span className="badge text-bg-light hint"><LocalCount value={selectedDocuments.length} /></span></div>
      {selectedDocuments.length === 0
        ? <div className="preview-empty"><i className="bi bi-files" /><strong>{t('noSelectedDocuments')}</strong><p>{t('noSelectedDocumentsHelp')}</p></div>
        : <>
          <div className="document-tabs" role="tablist">{selectedDocuments.map(document => {
            const name = documentDisplayName(document.fileName || t('unnamedDocument'), t('unnamedDocument'))
            const active = document.id === activeDocument?.id
            return <div className={`document-tab${active ? ' active' : ''}`} key={document.id} role="presentation">
              <button type="button" role="tab" aria-selected={active} className={active ? 'active' : ''} onClick={() => setActiveDocumentId(document.id)}>{name}</button>
              {onRemoveDocument && <button
                type="button"
                className="document-tab-remove"
                aria-label={t('removeDocument', { name })}
                title={t('removeDocument', { name })}
                onClick={() => onRemoveDocument(document.id)}
              ><i className="bi bi-x-lg me-1" aria-hidden="true" />{t('removeDocumentAction')}</button>}
            </div>
          })}</div>
          {activeDocument && <>
            <div className="document-preview-actions">
              <a className="btn btn-sm btn-outline-secondary" href={activeDocument.url} target="_blank" rel="noreferrer">
                <i className="bi bi-box-arrow-up-right me-1" aria-hidden="true" />{t('openDocument')}
              </a>
              {onRemoveDocument && <button type="button" className="btn btn-sm btn-outline-danger" aria-label={t('removeDocument', { name: activeDocumentName })} title={t('removeDocument', { name: activeDocumentName })} onClick={() => onRemoveDocument(activeDocument.id)}>
                <i className="bi bi-x-lg me-1" aria-hidden="true" />{t('removeDocumentAction')}
              </button>}
            </div>
            <iframe className="document-frame" src={activeDocument.url} title={activeDocument.fileName || t('documentPreview')} />
            <DocumentExtractionPanel documentId={activeDocument.id} />
          </>}
        </>}
    </section>
      <div
        className="column-resizer"
        role="separator"
        aria-label={t('resizeColumns')}
        aria-orientation="vertical"
        aria-valuemin={40}
        aria-valuemax={75}
        aria-valuenow={Math.round(documentColumnPercent)}
        tabIndex={0}
        onPointerDown={event => event.currentTarget.setPointerCapture(event.pointerId)}
        onPointerMove={resizeColumns}
        onKeyDown={resizeColumnsWithKeyboard}
      ><span /></div>
      {renderChildren()}
    </div>}
  </>
}

export function AttachedDocumentRow({
  document,
  fallbackName,
  openLabel,
  removeLabel,
  removeAccessibleLabel,
  onRemove,
}: {
  document: BookingDocument
  fallbackName: string
  openLabel: string
  removeLabel: string
  removeAccessibleLabel?: string
  onRemove?: () => void
}) {
  const name = documentDisplayName(document.fileName || fallbackName, fallbackName)
  const accessibleRemoveLabel = removeAccessibleLabel || removeLabel
  return <article className="attached-document-row" role="listitem">
    <div className="attached-document-details">
      <DocumentThumbnail document={document} />
      <strong className="document-name" title={name}>{name}</strong>
    </div>
    <div className="attached-document-actions">
      <a className="btn btn-sm btn-outline-secondary" href={document.url} target="_blank" rel="noreferrer">
        <i className="bi bi-box-arrow-up-right me-1" aria-hidden="true" />{openLabel}
      </a>
      {onRemove && <button type="button" className="btn btn-sm btn-outline-danger" aria-label={accessibleRemoveLabel} title={accessibleRemoveLabel} onClick={onRemove}>
        <i className="bi bi-x-lg me-1" aria-hidden="true" />{removeLabel}
      </button>}
    </div>
  </article>
}

export function DocumentCard({
  document,
  selected,
  fallbackName,
  onSelect,
}: {
  document: BookingDocument
  selected: boolean
  fallbackName: string
  onSelect: (extendSelection: boolean) => void
}) {
  const name = documentDisplayName(document.fileName || fallbackName, fallbackName)
  const longTouchGesture = useRef<LongTouchSelectionGesture | null>(null)
  longTouchGesture.current ??= new LongTouchSelectionGesture()

  useEffect(() => () => longTouchGesture.current?.dispose(), [])

  function startLongTouch(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.pointerType !== 'touch') return
    event.currentTarget.setPointerCapture(event.pointerId)
    longTouchGesture.current!.start(() => {
      onSelect(selectionExtendsForActivation(false, true))
    })
  }

  return <button
    type="button"
    className={`document-card ${selected ? 'selected' : ''}`}
    aria-pressed={selected}
    title={name}
    onPointerDown={startLongTouch}
    onPointerUp={() => longTouchGesture.current!.finish()}
    onPointerCancel={() => longTouchGesture.current!.cancel()}
    onClick={event => {
      if (longTouchGesture.current!.consumeClick()) return
      onSelect(selectionExtendsForActivation(event.shiftKey, false))
    }}
  >
    <DocumentThumbnail document={document} />
    <strong className="document-name">{name}</strong>
  </button>
}

export function selectDocument(selectedIds: string[], documentId: string, extendSelection: boolean): string[] {
  if (!extendSelection) return [documentId]
  return selectedIds.includes(documentId) ? selectedIds.filter(id => id !== documentId) : [...selectedIds, documentId]
}

/** Add one document to an existing attachment set without dropping prior choices. */
export function addDocumentSelection(selectedIds: string[], documentId: string): string[] {
  return selectedIds.includes(documentId) ? [...selectedIds] : [...selectedIds, documentId]
}

/** Whether the full picker/preview should be rendered for a compact document flow. */
export function documentPickerIsOpen(compactByDefault: boolean, addFlowOpen: boolean): boolean {
  return !compactByDefault || addFlowOpen
}

/** Collapse the compact add flow after a successful existing-document selection or upload. */
export function documentPickerOpenAfterAddition(compactByDefault: boolean): boolean {
  return !compactByDefault
}

export const longTouchSelectionDelayMs = 500

export class LongTouchSelectionGesture {
  private timer: ReturnType<typeof setTimeout> | null = null
  private ready = false
  private handled = false
  private onLongTouch: (() => void) | null = null

  start(onLongTouch: () => void) {
    this.cancel()
    this.onLongTouch = onLongTouch
    this.timer = setTimeout(() => {
      this.timer = null
      this.ready = true
    }, longTouchSelectionDelayMs)
  }

  finish() {
    this.clearTimer()
    if (!this.ready) return
    this.ready = false
    this.handled = true
    this.onLongTouch?.()
    this.onLongTouch = null
  }

  cancel() {
    this.clearTimer()
    this.ready = false
    this.handled = false
    this.onLongTouch = null
  }

  consumeClick(): boolean {
    const handled = this.handled
    this.handled = false
    return handled
  }

  dispose() {
    this.cancel()
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

export function documentDisplayName(fileName: string, fallbackName = fileName): string {
  return fileName.replace(/\.(?:pdf|xml)$/i, '') || fallbackName
}

export function selectionExtendsForActivation(shiftKey: boolean, longTouch: boolean): boolean {
  return shiftKey || longTouch
}

export function mergeDocumentSelection(selectedIds: string[], uploadedDocumentId: string): string[] {
  return selectedIds.includes(uploadedDocumentId) ? selectedIds : [...selectedIds, uploadedDocumentId]
}

export function mergeUploadedDocument(documents: BookingDocument[], uploadedDocument: BookingDocument): BookingDocument[] {
  return [uploadedDocument, ...documents.filter(document => document.id !== uploadedDocument.id)]
}

export function mergeDocumentLists(current: BookingDocument[], fetched: BookingDocument[]): BookingDocument[] {
  const merged = [...current]
  let changed = false
  for (const document of fetched) {
    const index = merged.findIndex(currentDocument => currentDocument.id === document.id)
    if (index < 0) {
      merged.push(document)
      changed = true
      continue
    }
    const existing = merged[index]
    const enriched = {
      ...existing,
      ...document,
      fileName: document.fileName || existing.fileName,
      contentType: document.contentType || existing.contentType,
      size: document.size ?? existing.size,
      thumbnailUrl: document.thumbnailUrl || existing.thumbnailUrl,
      url: document.url || existing.url,
    }
    if (JSON.stringify(existing) !== JSON.stringify(enriched)) {
      merged[index] = enriched
      changed = true
    }
  }
  return changed ? merged : current
}

export function availableBookingDocuments(documents: BookingDocument[], unavailableDocumentIds: ReadonlySet<string>): BookingDocument[] {
  return documents.filter(document => !unavailableDocumentIds.has(document.id))
}

/** Keep attached documents visible while the document library request is pending. */
export function attachedBookingDocuments(selectedIds: string[], documents: BookingDocument[]): BookingDocument[] {
  return selectedIds.map(id => documents.find(document => document.id === id) ?? {
    id,
    url: documentFileUrl(id),
  })
}

export function documentFileUrl(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}/file`
}

export function acceptedPdfFiles(files: ArrayLike<{ name: string; type: string }>): File[] {
  return Array.from(files).filter(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) as File[]
}

export function acceptedBookingDocumentFiles(files: ArrayLike<{ name: string; type: string }>): File[] {
  return Array.from(files).filter(file => ['application/pdf', 'application/xml', 'text/xml'].includes(file.type) || /\.(?:pdf|xml)$/i.test(file.name)) as File[]
}

export function clampDocumentColumnPercent(percent: number): number {
  return Math.min(75, Math.max(40, percent))
}

export function parseSavedDocumentColumnPercent(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const percent = Number(value)
  return Number.isFinite(percent) ? clampDocumentColumnPercent(percent) : null
}

export async function readDocumentUploadResponse(response: Response, fallbackMessage: string): Promise<BookingDocument> {
  const body = await getJSON(response).catch(() => null)
  const serverMessage = typeof body?.error === 'string' && body.error.trim() ? body.error : fallbackMessage
  if (!response.ok || !body?.data || typeof body.data !== 'object') throw new Error(serverMessage)
  return body.data as BookingDocument
}
