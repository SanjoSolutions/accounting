'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BookingDocuments, type BookingDocument } from './BookingDocuments'
import { LocalDate, LocalDateTime } from './LocalDate'
import { LocalCount } from './LocalNumber'
import { PageHeading } from './PageHeading'

export type BookingBatchVatTreatment = '' | 'DE_STANDARD_SALE_NET' | 'DE_STANDARD_PURCHASE_NET' | 'DE_STANDARD_SALE_GROSS' | 'DE_STANDARD_PURCHASE_GROSS' | 'EU_13B_SERVICE_RECIPIENT_NET'

export type BookingBatchAccount = {
  id: string
  number?: number | string
  name: string
  category?: string
}

export type BookingBatchLine = {
  accountId: string
  debitCents?: number
  creditCents?: number
  debit?: string | number | null
  credit?: string | number | null
  vatTreatment?: BookingBatchVatTreatment | null
  vat?: { ruleId?: string; mode?: string; direction?: string } | string | null
}

export type BookingBatchPosting = {
  fiscalYear: number
  bookingDate: string
  description: string
  documentIds: string[]
  lines: BookingBatchLine[]
}

export type BookingBatchDocument = {
  id: string
  url?: string
  fileName?: string
  contentType?: string
  size?: number
  thumbnailUrl?: string
}

export type BookingBatchDraft = {
  id: string
  version: number
  status: string
  updatedAt: string
  posting: BookingBatchPosting
  documents?: BookingBatchDocument[]
}

export type BookingBatchWorkspaceResponse = {
  fiscalYear: { year: number; status?: string } | number
  accounts: BookingBatchAccount[]
  drafts: BookingBatchDraft[]
}

export type EditableBookingBatchLine = {
  accountId: string
  debit: string
  credit: string
  vatTreatment: BookingBatchVatTreatment
}

export type EditableBookingBatchPosting = {
  fiscalYear: number
  bookingDate: string
  description: string
  documentIds: string[]
  lines: EditableBookingBatchLine[]
}

/** Converts API metadata into the richer document shape used by the picker. */
export function bookingBatchDocumentForPicker(document: BookingBatchDocument): BookingDocument {
  return {
    id: document.id,
    url: document.url || `/api/documents/${encodeURIComponent(document.id)}/file`,
    ...(document.fileName ? { fileName: document.fileName } : {}),
    ...(document.contentType ? { contentType: document.contentType } : {}),
    ...(document.size === undefined ? {} : { size: document.size }),
    ...(document.thumbnailUrl ? { thumbnailUrl: document.thumbnailUrl } : {}),
  }
}

export function bookingBatchDocumentsForPicker(documents: BookingBatchDocument[] | undefined): BookingDocument[] {
  return Array.isArray(documents) ? documents.map(bookingBatchDocumentForPicker) : []
}

export function unlinkBookingBatchDocument(documentIds: string[], documentId: string): string[] {
  return documentIds.filter(id => id !== documentId)
}

const emptyLine = (): EditableBookingBatchLine => ({ accountId: '', debit: '', credit: '', vatTreatment: '' })

const vatTreatments: BookingBatchVatTreatment[] = [
  '',
  'DE_STANDARD_SALE_NET',
  'DE_STANDARD_PURCHASE_NET',
  'DE_STANDARD_SALE_GROSS',
  'DE_STANDARD_PURCHASE_GROSS',
  'EU_13B_SERVICE_RECIPIENT_NET',
]

export function bookingBatchYearFromSearchParameter(value: string | string[] | undefined, currentYear = new Date().getFullYear()) {
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) return currentYear
  const year = Number(value)
  return year >= 1900 && year <= 2200 ? year : currentYear
}

export function bookingBatchDraftsForYear(response: BookingBatchWorkspaceResponse, year: number) {
  const drafts = Array.isArray(response.drafts) ? response.drafts : []
  return drafts.filter(draft => draft.status === 'DRAFT' && Number(draft.posting?.fiscalYear) === year)
}

export function bookingBatchVatTreatment(value: BookingBatchLine): BookingBatchVatTreatment {
  if (value.vatTreatment && vatTreatments.includes(value.vatTreatment)) return value.vatTreatment
  if (!value.vat) return ''
  if (typeof value.vat === 'string' && vatTreatments.includes(value.vat as BookingBatchVatTreatment)) return value.vat as BookingBatchVatTreatment
  if (typeof value.vat !== 'object') return ''
  if (value.vat.ruleId === 'EU_13B_SERVICE_RECIPIENT' && value.vat.mode === 'net' && value.vat.direction === 'purchase') return 'EU_13B_SERVICE_RECIPIENT_NET'
  const mode = value.vat.mode === 'gross' ? 'GROSS' : value.vat.mode === 'net' ? 'NET' : ''
  const direction = value.vat.direction === 'purchase' ? 'PURCHASE' : value.vat.direction === 'sale' ? 'SALE' : ''
  const treatment = `DE_STANDARD_${direction}_${mode}`
  return vatTreatments.includes(treatment as BookingBatchVatTreatment) ? treatment as BookingBatchVatTreatment : ''
}

function amountToInput(value: string | number | null | undefined, cents = false) {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'number' && cents) return value === 0 ? '' : (value / 100).toFixed(2)
  return String(value)
}

export function editableBookingBatchPosting(posting: BookingBatchPosting): EditableBookingBatchPosting {
  const lines = Array.isArray(posting.lines) ? posting.lines : []
  return {
    fiscalYear: posting.fiscalYear,
    bookingDate: posting.bookingDate.slice(0, 10),
    description: posting.description,
    documentIds: Array.isArray(posting.documentIds) ? [...posting.documentIds] : [],
    lines: lines.length > 0
      ? lines.map(line => ({
        accountId: line.accountId,
        debit: amountToInput(line.debitCents, true) || amountToInput(line.debit),
        credit: amountToInput(line.creditCents, true) || amountToInput(line.credit),
        vatTreatment: bookingBatchVatTreatment(line),
      }))
      : [emptyLine(), emptyLine()],
  }
}

function amountToCents(value: string) {
  const amount = Number(value || 0)
  return Number.isFinite(amount) ? Math.round(amount * 100) : 0
}

export function bookingBatchLineRequest(line: EditableBookingBatchLine) {
  const treatment = line.vatTreatment
  const vat = treatment ? {
    ruleId: treatment === 'EU_13B_SERVICE_RECIPIENT_NET' ? 'EU_13B_SERVICE_RECIPIENT' : 'DE_STANDARD',
    mode: treatment.endsWith('_GROSS') ? 'gross' as const : 'net' as const,
    direction: treatment === 'EU_13B_SERVICE_RECIPIENT_NET' || treatment.includes('_PURCHASE_') ? 'purchase' as const : 'sale' as const,
  } : undefined
  return {
    accountId: line.accountId,
    debitCents: amountToCents(line.debit),
    creditCents: amountToCents(line.credit),
    ...(vat ? { vat } : {}),
  }
}

export function bookingBatchPatchRequest(expectedVersion: number, posting: EditableBookingBatchPosting) {
  return {
    expectedVersion,
    fiscalYear: posting.fiscalYear,
    bookingDate: posting.bookingDate,
    description: posting.description,
    documentIds: [...posting.documentIds],
    lines: posting.lines.map(bookingBatchLineRequest),
  }
}

export function bookingBatchPostRequest(reason: string, expectedVersion?: number) {
  const trimmedReason = reason.trim()
  return { ...(trimmedReason ? { reason: trimmedReason } : {}), ...(expectedVersion === undefined ? {} : { expectedVersion }) }
}

function normalizeDraft(value: unknown): BookingBatchDraft | null {
  if (!value || typeof value !== 'object') return null
  const draft = value as Partial<BookingBatchDraft>
  if (typeof draft.id !== 'string' || typeof draft.version !== 'number' || typeof draft.status !== 'string' || typeof draft.updatedAt !== 'string' || !draft.posting) return null
  return draft as BookingBatchDraft
}

function responseDraft(value: unknown): BookingBatchDraft | null {
  if (!value || typeof value !== 'object') return null
  const body = value as { draft?: unknown; data?: unknown }
  const data = body.data && typeof body.data === 'object' ? body.data as { draft?: unknown } : null
  return normalizeDraft(value) ?? normalizeDraft(body.draft) ?? normalizeDraft(body.data) ?? normalizeDraft(data?.draft)
}

async function readResponseBody(response: Response): Promise<unknown> {
  try { return await response.json() } catch { return null }
}

function apiError(body: unknown, fallback: string) {
  if (!body || typeof body !== 'object') return fallback
  const value = body as { error?: unknown; message?: unknown; issues?: unknown }
  if (typeof value.error === 'string') return value.error
  if (typeof value.message === 'string') return value.message
  if (Array.isArray(value.issues)) return value.issues.filter(item => typeof item === 'string').join(' ') || fallback
  return fallback
}

function accountLabel(account: BookingBatchAccount) {
  const number = account.number === undefined || account.number === null || account.number === '' ? '' : `${String(account.number).padStart(4, '0')} · `
  return `${number}${account.name}`
}

function draftStatusClass(status: string) {
  if (status === 'DRAFT') return 'text-bg-warning'
  if (status === 'POSTED') return 'text-bg-success'
  return 'text-bg-secondary'
}

export function BookingBatchWorkspace({ initialYear = new Date().getFullYear() }: { initialYear?: number }) {
  const t = useTranslations('BookingBatches')
  const postReasonHint = t('postReasonHint')
  const [year, setYear] = useState(initialYear)
  const [workspace, setWorkspace] = useState<BookingBatchWorkspaceResponse | null>(null)
  const [selectedDraftId, setSelectedDraftId] = useState('')
  const [posting, setPosting] = useState<EditableBookingBatchPosting | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [documentsUploading, setDocumentsUploading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')

  const drafts = useMemo(() => workspace ? bookingBatchDraftsForYear(workspace, year) : [], [workspace, year])
  const selectedDraft = drafts.find(draft => draft.id === selectedDraftId) ?? drafts[0]
  const savedPosting = selectedDraft ? editableBookingBatchPosting(selectedDraft.posting) : null
  const dirty = Boolean(posting && savedPosting && JSON.stringify(posting) !== JSON.stringify(savedPosting))
  const selectedDraftDocuments = useMemo(
    () => bookingBatchDocumentsForPicker(selectedDraft?.documents),
    [selectedDraft?.documents],
  )

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`/api/booking-batches?year=${year}`, { signal })
      const body = await readResponseBody(response)
      if (!response.ok) throw new Error(apiError(body, t('loadFailed')))
      const value = body as BookingBatchWorkspaceResponse
      setWorkspace(value)
      const nextDrafts = bookingBatchDraftsForYear(value, year)
      setSelectedDraftId(current => nextDrafts.some(draft => draft.id === current) ? current : nextDrafts[0]?.id ?? '')
      setStatus('')
    } catch (cause) {
      if ((cause as { name?: string }).name !== 'AbortError') setError(cause instanceof Error ? cause.message : t('loadFailed'))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [t, year])

  useEffect(() => {
    setYear(initialYear)
  }, [initialYear])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  useEffect(() => {
    if (!selectedDraft) {
      setPosting(null)
      return
    }
    setPosting(editableBookingBatchPosting(selectedDraft.posting))
    setReason('')
  }, [selectedDraft?.id, selectedDraft?.version])

  function selectDraft(id: string) {
    if (id === selectedDraftId) return
    setSelectedDraftId(id)
    setStatus('')
    setError('')
  }

  function updateLine(index: number, field: keyof EditableBookingBatchLine, value: string) {
    setPosting(current => current ? {
      ...current,
      lines: current.lines.map((line, lineIndex) => lineIndex !== index ? line : {
        ...line,
        [field]: value,
        ...(field === 'debit' && value ? { credit: '' } : {}),
        ...(field === 'credit' && value ? { debit: '' } : {}),
      }),
    } : current)
  }

  async function save() {
    if (!selectedDraft || !posting || documentsUploading) return
    setBusy(true); setError(''); setStatus('')
    try {
      const response = await fetch(`/api/booking-batches/${encodeURIComponent(selectedDraft.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bookingBatchPatchRequest(selectedDraft.version, posting)),
      })
      const body = await readResponseBody(response)
      if (!response.ok) {
        if (response.status === 409) throw new Error(t('versionConflict'))
        throw new Error(apiError(body, t('saveFailed')))
      }
      const updatedDraft = responseDraft(body)
      if (!updatedDraft) throw new Error(t('saveFailed'))
      setWorkspace(current => current ? { ...current, drafts: current.drafts.map(draft => draft.id === updatedDraft.id ? updatedDraft : draft) } : current)
      setPosting(editableBookingBatchPosting(updatedDraft.posting))
      setStatus(t('saved'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('saveFailed'))
    } finally { setBusy(false) }
  }

  async function postToJournal() {
    if (!selectedDraft || !posting || dirty) return
    setBusy(true); setError(''); setStatus('')
    try {
      const response = await fetch(`/api/booking-batches/${encodeURIComponent(selectedDraft.id)}/post`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bookingBatchPostRequest(reason, selectedDraft.version)),
      })
      const body = await readResponseBody(response)
      if (!response.ok) throw new Error(response.status === 409 ? t('versionConflict') : apiError(body, t('postFailed')))
      setWorkspace(current => current ? { ...current, drafts: current.drafts.filter(draft => draft.id !== selectedDraft.id) } : current)
      setSelectedDraftId('')
      setPosting(null)
      setReason('')
      setStatus(t('posted'))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('postFailed'))
    } finally { setBusy(false) }
  }

  return <div className="booking-batch-workspace workspace pb-4">
    <PageHeading title={t('title')} subtitle={t('subtitle')} />

    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {status && <div className="alert alert-success" role="status">{status}</div>}
    {loading && <div className="alert alert-info" role="status" aria-live="polite">{t('loading')}</div>}

    {!loading && workspace && <div className="row g-4 align-items-start">
      <aside className="col-lg-4" aria-label={t('draftList')}>
        <section className="card h-100">
          <div className="card-body">
            <div className="d-flex justify-content-between align-items-start gap-2 mb-3">
              <div><h2 className="h5 mb-1">{t('draftList')}</h2><p className="small text-muted mb-0">{t('draftListHint', { year })}</p></div>
              <span className="badge text-bg-light"><LocalCount value={drafts.length} /></span>
            </div>
            {drafts.length === 0 && <div className="text-center text-muted py-4"><i className="bi bi-inbox fs-2 d-block mb-2" aria-hidden="true" /><strong className="d-block text-body">{t('empty')}</strong><span className="small">{t('emptyHint')}</span></div>}
            {drafts.length > 0 && <div className="list-group" role="listbox" aria-label={t('draftList')}>
              {drafts.map(draft => <button key={draft.id} type="button" role="option" aria-selected={draft.id === selectedDraft?.id} className={`list-group-item list-group-item-action text-start${draft.id === selectedDraft?.id ? ' active' : ''}`} onClick={() => selectDraft(draft.id)}>
                <span className="d-flex justify-content-between align-items-start gap-2"><strong className="text-truncate">{draft.posting.description || t('untitled')}</strong><span className={`badge ${draftStatusClass(draft.status)}`}>{draft.status === 'DRAFT' ? t('status.DRAFT') : draft.status}</span></span>
                <span className="d-block small mt-1"><LocalDate value={draft.posting.bookingDate} /></span>
                <span className="d-block small opacity-75">{t('updatedAtLabel')} <LocalDateTime value={draft.updatedAt} /></span>
              </button>)}
            </div>}
          </div>
        </section>
      </aside>

      <section className="col-lg-8" aria-label={t('editor')}>
        {!selectedDraft || !posting ? <div className="card"><div className="card-body text-center text-muted py-5"><i className="bi bi-pencil-square fs-2 d-block mb-2" aria-hidden="true" />{t('selectDraft')}</div></div> : <BookingDocuments
          key={selectedDraft.id}
          compactByDefault
          selectedDocumentIds={posting.documentIds}
          initialDocuments={selectedDraftDocuments}
          onSelectionChange={documentIds => setPosting(current => current ? { ...current, documentIds } : current)}
          onUploadingChange={setDocumentsUploading}
          onRemoveDocument={documentId => setPosting(current => current ? { ...current, documentIds: unlinkBookingBatchDocument(current.documentIds, documentId) } : current)}
        >
          {({ attachedDocuments, pickerOpen }) => <section className="card panel booking-panel">
          <div className="card-body">
            <div className="d-flex justify-content-between align-items-start gap-3 mb-4"><div><h2 className="h4 mb-1">{posting.description || t('untitled')}</h2><p className="small text-muted mb-0">{t('versionLabel', { version: selectedDraft.version })}</p></div><span className={`badge ${draftStatusClass(selectedDraft.status)}`}>{selectedDraft.status === 'DRAFT' ? t('status.DRAFT') : selectedDraft.status}</span></div>
            <form onSubmit={event => { event.preventDefault(); void save() }}>
              <fieldset disabled={busy}>
                <legend className="visually-hidden">{t('editor')}</legend>
                <div className="row g-3 mb-3">
                  <div className="col-md-8"><label htmlFor="booking-batch-description">{t('description')}<input id="booking-batch-description" className="form-control" required maxLength={240} value={posting.description} onChange={event => setPosting(current => current ? { ...current, description: event.target.value } : current)} /></label></div>
                  <div className="col-md-4"><label htmlFor="booking-batch-date">{t('bookingDate')}<input id="booking-batch-date" className="form-control" required type="date" value={posting.bookingDate} onChange={event => setPosting(current => current ? { ...current, bookingDate: event.target.value } : current)} /></label></div>
                </div>
                <div className="table-responsive mb-2"><table className="table align-middle booking-batch-lines"><caption className="visually-hidden">{t('lines')}</caption><thead><tr><th scope="col">{t('account')}</th><th scope="col" className="text-end">{t('debit')}</th><th scope="col" className="text-end">{t('credit')}</th><th scope="col">{t('vatTreatment')}</th><th scope="col"><span className="visually-hidden">{t('actions')}</span></th></tr></thead><tbody>
                  {posting.lines.map((line, index) => <tr key={index}><td><label className="visually-hidden" htmlFor={`booking-batch-account-${index}`}>{t('accountLine', { line: index + 1 })}</label><select id={`booking-batch-account-${index}`} className="form-select" required value={line.accountId} onChange={event => updateLine(index, 'accountId', event.target.value)}><option value="">{t('chooseAccount')}</option>{workspace.accounts.map(account => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}</select></td><td><label className="visually-hidden" htmlFor={`booking-batch-debit-${index}`}>{t('debitLine', { line: index + 1 })}</label><div className="input-group"><input id={`booking-batch-debit-${index}`} className="form-control text-end" inputMode="decimal" min="0" step="0.01" type="number" value={line.debit} onChange={event => updateLine(index, 'debit', event.target.value)} /><span className="input-group-text">€</span></div></td><td><label className="visually-hidden" htmlFor={`booking-batch-credit-${index}`}>{t('creditLine', { line: index + 1 })}</label><div className="input-group"><input id={`booking-batch-credit-${index}`} className="form-control text-end" inputMode="decimal" min="0" step="0.01" type="number" value={line.credit} onChange={event => updateLine(index, 'credit', event.target.value)} /><span className="input-group-text">€</span></div></td><td><label className="visually-hidden" htmlFor={`booking-batch-vat-${index}`}>{t('vatLine', { line: index + 1 })}</label><select id={`booking-batch-vat-${index}`} className="form-select" value={line.vatTreatment} onChange={event => updateLine(index, 'vatTreatment', event.target.value)}><option value="">{t('vatNone')}</option><option value="DE_STANDARD_SALE_NET">{t('vatStandardSaleNet')}</option><option value="DE_STANDARD_PURCHASE_NET">{t('vatStandardPurchaseNet')}</option><option value="DE_STANDARD_SALE_GROSS">{t('vatStandardSaleGross')}</option><option value="DE_STANDARD_PURCHASE_GROSS">{t('vatStandardPurchaseGross')}</option><option value="EU_13B_SERVICE_RECIPIENT_NET">{t('vatEuServiceReverseChargeNet')}</option></select></td><td><button type="button" className="btn btn-outline-secondary" aria-label={t('removeLine', { line: index + 1 })} disabled={posting.lines.length <= 2} onClick={() => setPosting(current => current ? { ...current, lines: current.lines.filter((_, lineIndex) => lineIndex !== index) } : current)}><i className="bi bi-trash" aria-hidden="true" /></button></td></tr>)}
                </tbody></table></div>
                <button type="button" className="btn btn-link px-0" onClick={() => setPosting(current => current ? { ...current, lines: [...current.lines, emptyLine()] } : current)}><i className="bi bi-plus-circle me-1" aria-hidden="true" />{t('addLine')}</button>
                {!pickerOpen && attachedDocuments}
              </fieldset>
              {dirty && <p className="small text-warning-emphasis mt-3 mb-0" role="status"><i className="bi bi-pencil me-1" aria-hidden="true" />{t('unsavedChanges')}</p>}
              <div className="d-flex flex-wrap gap-2 align-items-end border-top pt-3 mt-3"><button className="btn btn-primary" type="submit" disabled={busy || documentsUploading || !dirty}>{busy ? t('saving') : t('save')}</button><div className="flex-grow-1"><label htmlFor="booking-batch-reason">{t('postReason')}{postReasonHint ? <span className="small text-muted fw-normal">{' '}{postReasonHint}</span> : null}<input id="booking-batch-reason" className="form-control" value={reason} disabled={busy || dirty} onChange={event => setReason(event.target.value)} /></label></div><button type="button" className="btn btn-success" disabled={busy || documentsUploading || dirty} onClick={() => void postToJournal()}><i className="bi bi-journal-check me-1" aria-hidden="true" />{busy ? t('posting') : t('postToJournal')}</button></div>
            </form>
          </div>
          </section>}
        </BookingDocuments>}
      </section>
    </div>}
  </div>
}
