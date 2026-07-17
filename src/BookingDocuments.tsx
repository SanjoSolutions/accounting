"use client"

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { api, getJSON } from './Requester'

export type BookingDocument = {
  id: string
  url: string
  fileName?: string
  size?: number
}

const documentColumnStorageKey = 'accounting.bookings.document-column-percent'

export function BookingDocuments({
  selectedDocumentIds,
  onSelectionChange,
  onUploadingChange,
  children,
}: {
  selectedDocumentIds: string[]
  onSelectionChange: (ids: string[]) => void
  onUploadingChange: (uploading: boolean) => void
  children: ReactNode
}) {
  const t = useTranslations('Workspaces')
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)
  const uploadingRef = useRef(false)
  const selectedDocumentIdsRef = useRef(selectedDocumentIds)
  selectedDocumentIdsRef.current = selectedDocumentIds
  const [documents, setDocuments] = useState<BookingDocument[]>([])
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [documentColumnPercent, setDocumentColumnPercent] = useState(60)

  useEffect(() => {
    const saved = parseSavedDocumentColumnPercent(window.localStorage.getItem(documentColumnStorageKey))
    if (saved !== null) setDocumentColumnPercent(saved)
  }, [])

  useEffect(() => {
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
  }, [t])

  const upload = useCallback(async (fileList: ArrayLike<File>) => {
    if (uploadingRef.current) return
    const files = acceptedPdfFiles(fileList)
    if (!files.length) { setError(t('pdfOnly')); return }
    uploadingRef.current = true
    setUploading(true)
    onUploadingChange(true)
    setError('')
    try {
      for (const file of files) {
        const response = await api.postFile('/api/documents', file)
        const body = await getJSON(response)
        if (!response.ok) throw new Error(body.error || t('documentUploadFailed'))
        const uploadedDocument = body.data as BookingDocument
        setDocuments(current => mergeUploadedDocument(current, uploadedDocument))
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
    }
  }, [onSelectionChange, onUploadingChange, t])

  useEffect(() => {
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
  }, [upload])

  const selectedDocuments = useMemo(
    () => selectedDocumentIds.flatMap(id => documents.find(document => document.id === id) ?? []),
    [documents, selectedDocumentIds],
  )
  const activeDocument = selectedDocuments.find(document => document.id === activeDocumentId) ?? selectedDocuments[0]

  function toggle(documentId: string) {
    const next = toggleDocumentSelection(selectedDocumentIds, documentId)
    onSelectionChange(next)
    if (next.includes(documentId)) setActiveDocumentId(documentId)
    else if (activeDocumentId === documentId) setActiveDocumentId(next[0] ?? null)
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

  return <>
    {dragging && <div className="viewport-drop-target" role="status"><div><i className="bi bi-cloud-arrow-up" /><strong>{t('dropDocuments')}</strong><span>{t('dropDocumentsHelp')}</span></div></div>}
    <section className="panel document-picker-panel">
      <div className="panel-title">
        <div><span className="step">1 · {t('uploadDocuments')}</span><h2>{t('selectDocuments')}</h2><p>{t('documentsHelp')}</p></div>
        <div className="document-actions">
          <span className="selection-count">{t('documentsSelected', { count: selectedDocumentIds.length })}</span>
          <button className="secondary-action" type="button" disabled={uploading} onClick={() => inputRef.current?.click()}>
            <i className="bi bi-plus-lg" /> {uploading ? t('uploadingDocuments') : t('chooseDocuments')}
          </button>
          <input ref={inputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" multiple onChange={event => event.target.files && void upload(event.target.files)} />
        </div>
      </div>
      {error && <div className="error-summary" role="alert">{error}</div>}
      {documents.length === 0 && !uploading
        ? <div className="document-empty" onClick={() => inputRef.current?.click()}><i className="bi bi-file-earmark-arrow-up" /><strong>{t('noDocuments')}</strong><span>{t('noDocumentsHelp')}</span></div>
        : <div className="document-strip" aria-label={t('availableDocuments')}>{documents.map(document => {
          const selected = selectedDocumentIds.includes(document.id)
          return <button key={document.id} type="button" className={`document-card ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={() => toggle(document.id)}>
            <span className="document-icon"><i className="bi bi-file-earmark-pdf" /></span>
            <span><strong>{document.fileName || t('unnamedDocument')}</strong><small>{formatFileSize(document.size)}</small></span>
            <i className={`selection-mark bi ${selected ? 'bi-check-circle-fill' : 'bi-circle'}`} />
          </button>
        })}</div>}
    </section>

    <div className="booking-workflow-columns" style={{ '--document-column': `${documentColumnPercent}%` } as React.CSSProperties}>
    <section className="panel document-preview-panel">
      <div className="panel-title"><div><span className="step">{t('selectedDocuments')}</span><h2>{t('documentPreview')}</h2></div><span className="hint">{selectedDocuments.length}</span></div>
      {selectedDocuments.length === 0
        ? <div className="preview-empty"><i className="bi bi-files" /><strong>{t('noSelectedDocuments')}</strong><p>{t('noSelectedDocumentsHelp')}</p></div>
        : <>
          <div className="document-tabs" role="tablist">{selectedDocuments.map(document => <button key={document.id} type="button" role="tab" aria-selected={document.id === activeDocument?.id} className={document.id === activeDocument?.id ? 'active' : ''} onClick={() => setActiveDocumentId(document.id)}>{document.fileName || t('unnamedDocument')}</button>)}</div>
          {activeDocument && <iframe className="document-frame" src={activeDocument.url} title={activeDocument.fileName || t('documentPreview')} />}
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
      {children}
    </div>
  </>
}

export function toggleDocumentSelection(selectedIds: string[], documentId: string): string[] {
  return selectedIds.includes(documentId) ? selectedIds.filter(id => id !== documentId) : [...selectedIds, documentId]
}

export function mergeDocumentSelection(selectedIds: string[], uploadedDocumentId: string): string[] {
  return selectedIds.includes(uploadedDocumentId) ? selectedIds : [...selectedIds, uploadedDocumentId]
}

export function mergeUploadedDocument(documents: BookingDocument[], uploadedDocument: BookingDocument): BookingDocument[] {
  return [uploadedDocument, ...documents.filter(document => document.id !== uploadedDocument.id)]
}

export function mergeDocumentLists(current: BookingDocument[], fetched: BookingDocument[]): BookingDocument[] {
  const currentIds = new Set(current.map(document => document.id))
  return [...current, ...fetched.filter(document => !currentIds.has(document.id))]
}

export function acceptedPdfFiles(files: ArrayLike<{ name: string; type: string }>): File[] {
  return Array.from(files).filter(file => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) as File[]
}

export function clampDocumentColumnPercent(percent: number): number {
  return Math.min(75, Math.max(40, percent))
}

export function parseSavedDocumentColumnPercent(value: string | null): number | null {
  if (value === null || value.trim() === '') return null
  const percent = Number(value)
  return Number.isFinite(percent) ? clampDocumentColumnPercent(percent) : null
}

function formatFileSize(size?: number) {
  if (!size) return 'PDF'
  return size < 1024 * 1024 ? `${Math.ceil(size / 1024)} KB · PDF` : `${(size / 1024 / 1024).toFixed(1)} MB · PDF`
}
