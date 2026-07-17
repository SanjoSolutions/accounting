"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BookingDocuments, type BookingDocument } from './BookingDocuments'

type Account = { id: string; number: number; name: string; category: string }
type Line = { accountId: string; debit: string; credit: string }
export type BookingWorkspaceState = {
  year: number
  bookingDate: string
  documentNumber: string
  description: string
  lines: Line[]
  selectedDocumentIds: string[]
}
type Workspace = {
  fiscalYear: { year: number; status: string }
  accounts: Account[]
  entries: Array<{
    id: string; sequenceNumber: number; bookingDate: string; documentNumber: string; description: string
    lines: Array<{ id: string; debitCents: number; creditCents: number; account: Account }>
    documents: BookingDocument[]
  }>
  statements: { assetsCents: number; liabilitiesCents: number; equityCents: number; netIncomeCents: number }
}

const emptyLine = (): Line => ({ accountId: '', debit: '', credit: '' })
const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })

export function AccountingWorkspace({ ownerId }: { ownerId: string }) {
  const t = useTranslations('Workspaces')
  const [year, setYear] = useState(new Date().getFullYear())
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()])
  const [bookingDate, setBookingDate] = useState(localDate)
  const [documentNumber, setDocumentNumber] = useState('')
  const [description, setDescription] = useState('')
  const [issues, setIssues] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState('')
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([])
  const [documentsUploading, setDocumentsUploading] = useState(false)
  const [storageRestored, setStorageRestored] = useState(false)
  const yearRef = useRef(year)
  const loadRef = useRef(0)
  const suppressNextDraftSaveRef = useRef(false)
  const bookingWorkspaceStateRef = useRef<BookingWorkspaceState>({
    year, bookingDate, documentNumber, description, lines, selectedDocumentIds,
  })
  bookingWorkspaceStateRef.current = {
    year, bookingDate, documentNumber, description, lines, selectedDocumentIds,
  }

  useEffect(() => {
    const storage = getBrowserBookingWorkspaceStorage()
    const saved = storage ? loadBookingWorkspaceState(storage, ownerId) : null
    if (saved) {
      bookingWorkspaceStateRef.current = saved
      setYear(saved.year)
      setBookingDate(saved.bookingDate)
      setDocumentNumber(saved.documentNumber)
      setDescription(saved.description)
      setLines(saved.lines)
      setSelectedDocumentIds(saved.selectedDocumentIds)
    }
    setStorageRestored(true)
  }, [ownerId])

  useEffect(() => {
    if (!storageRestored) return
    if (consumeBookingWorkspaceSaveSuppression(suppressNextDraftSaveRef)) return
    const storage = getBrowserBookingWorkspaceStorage()
    if (!storage) return
    saveBookingWorkspaceState(storage, ownerId, {
      year, bookingDate, documentNumber, description, lines, selectedDocumentIds,
    })
  }, [storageRestored, ownerId, year, bookingDate, documentNumber, description, lines, selectedDocumentIds])

  const load = useCallback(async (signal?: AbortSignal) => {
    const requestedYear = year
    const requestId = ++loadRef.current
    if (requestedYear === yearRef.current) setWorkspace(null)
    try {
      const response = await fetch(`/api/booking-records?year=${requestedYear}`, { signal })
      if (!response.ok) throw new Error('load failed')
      const body = await response.json()
      if (shouldApplyWorkspace(requestedYear, yearRef.current, signal?.aborted ?? false, requestId, loadRef.current)) { setWorkspace(body); setIssues([]) }
    } catch (error) {
      if ((error as { name?: string }).name !== 'AbortError' && requestedYear === yearRef.current && requestId === loadRef.current) setIssues([t('bookingsLoadFailed')])
    }
  }, [year])
  useEffect(() => {
    yearRef.current = year
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load, year])

  const totals = useMemo(() => lines.reduce((sum, line) => ({
    debit: sum.debit + toCents(line.debit), credit: sum.credit + toCents(line.credit),
  }), { debit: 0, credit: 0 }), [lines])
  const difference = totals.debit - totals.credit
  const currentWorkspace = workspace?.fiscalYear.year === year ? workspace : null

  function updateLine(index: number, field: keyof Line, value: string) {
    setLines(current => current.map((line, lineIndex) => lineIndex === index
      ? { ...line, [field]: value, ...(field === 'debit' && value ? { credit: '' } : {}), ...(field === 'credit' && value ? { debit: '' } : {}) }
      : line))
  }

  function updateDescription(value: string) {
    setDescription(value)
    if (!storageRestored) return
    const storage = getBrowserBookingWorkspaceStorage()
    if (storage) bookingWorkspaceStateRef.current = persistBookingWorkspaceStateChange(
      storage, ownerId, bookingWorkspaceStateRef.current, { description: value },
    )
  }

  async function post(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setIssues([]); setSuccess('')
    const submittedYear = year
    if (documentsUploading) { setBusy(false); return }
    if (!workspace || workspace.fiscalYear.year !== year) { setIssues([t('bookingsLoadFailed')]); setBusy(false); return }
    try {
      const response = await fetch('/api/booking-records', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fiscalYear: year, bookingDate, documentNumber, description, documentIds: selectedDocumentIds, lines: lines.map(line => ({ accountId: line.accountId, debitCents: toCents(line.debit), creditCents: toCents(line.credit) })) }),
      })
      if (!response.ok) { const body = await response.json(); if (yearRef.current === submittedYear) setIssues(body.issues ?? [t('postingFailed')]); return }
      if (yearRef.current === submittedYear) {
        const storage = getBrowserBookingWorkspaceStorage()
        suppressNextDraftSaveRef.current = storage ? clearBookingWorkspaceState(storage, ownerId) : false
        const clearedLines = [emptyLine(), emptyLine()]
        bookingWorkspaceStateRef.current = {
          ...bookingWorkspaceStateRef.current,
          lines: clearedLines,
          documentNumber: '',
          description: '',
          selectedDocumentIds: [],
        }
        setLines(clearedLines); setDocumentNumber(''); setDescription(''); setSelectedDocumentIds([]); setSuccess(t('postingSaved')); await load()
      }
    } catch { if (yearRef.current === submittedYear) setIssues([t('postingFailed')]) }
    finally { if (yearRef.current === submittedYear) setBusy(false) }
  }

  return <div className="workspace bookings-workspace py-4">
    <header className="page-heading">
      <div><span className="eyebrow">{t('generalLedger')}</span><h1>{t('bookings')}</h1><p>{t('bookingsSubtitle')}</p></div>
      <label className="year-picker">{t('fiscalYear')}<input disabled={busy} type="number" value={year} onChange={event => { const nextYear = Number(event.target.value); setWorkspace(null); setIssues([]); setSuccess(''); setYear(nextYear); if (Number(bookingDate.slice(0, 4)) !== nextYear) setBookingDate(`${nextYear}-01-01`) }} /></label>
    </header>

    {currentWorkspace && <section className="metric-grid" aria-label="Kennzahlen">
      <Metric label={t('assets')} value={currentWorkspace.statements.assetsCents} />
      <Metric label={t('liabilitiesEquity')} value={currentWorkspace.statements.liabilitiesCents + currentWorkspace.statements.equityCents} />
      <Metric label={t('provisionalResult')} value={currentWorkspace.statements.netIncomeCents} />
      <div className="metric"><span>{t('status')}</span><strong className={`status ${currentWorkspace.fiscalYear.status.toLowerCase()}`}>{currentWorkspace.fiscalYear.status === 'OPEN' ? t('open') : t('locked')}</strong></div>
    </section>}

    <BookingDocuments selectedDocumentIds={selectedDocumentIds} onSelectionChange={setSelectedDocumentIds} onUploadingChange={setDocumentsUploading}>
      <section className="panel booking-panel">
        <div className="panel-title"><div><span className="step">2 · {t('newPosting')}</span><h2>{t('recordTransaction')}</h2></div><span className="hint">{t('debitEqualsCredit')}</span></div>
        <form onSubmit={post}>
          <fieldset disabled={isBookingFormDisabled(busy, documentsUploading, !storageRestored)}>
          <div className="form-grid two booking-metadata-row">
            <label>{t('postingDate')}<input required type="date" value={bookingDate} onChange={event => setBookingDate(event.target.value)} /></label>
            <label>{t('documentNumber')}<input required value={documentNumber} onChange={event => setDocumentNumber(event.target.value)} placeholder={t('documentPlaceholder')} /></label>
          </div>
          <div className="form-grid booking-description-row">
            <label>{t('postingText')}<input required value={description} onChange={event => updateDescription(event.target.value)} placeholder={t('postingPlaceholder')} /></label>
          </div>
          <div className="posting-head"><span>{t('account')}</span><span>{t('debit')}</span><span>{t('credit')}</span><span /></div>
          {lines.map((line, index) => <div className="posting-line" key={index}>
            <select required aria-label={t('accountLine', { line: index + 1 })} value={line.accountId} onChange={event => updateLine(index, 'accountId', event.target.value)}>
              <option value="">{t('chooseAccount')}</option>
              {currentWorkspace?.accounts.map(account => <option key={account.id} value={account.id}>{account.number} · {account.name}</option>)}
            </select>
            <MoneyInput label={t('debitLine', { line: index + 1 })} value={line.debit} onChange={value => updateLine(index, 'debit', value)} />
            <MoneyInput label={t('creditLine', { line: index + 1 })} value={line.credit} onChange={value => updateLine(index, 'credit', value)} />
            <button type="button" className="icon-button" aria-label={t('removeLine', { line: index + 1 })} disabled={lines.length <= 2} onClick={() => setLines(current => current.filter((_, i) => i !== index))}>×</button>
          </div>)}
          <button className="add-line" type="button" onClick={() => setLines(current => [...current, emptyLine()])}>+ {t('addSplitLine')}</button>
          {issues.length > 0 && <div className="error-summary" role="alert"><strong>{t('pleaseReview')}</strong><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
          {success && <p className="success" role="status">{success}</p>}
          <div className={`balance-bar ${difference === 0 && totals.debit > 0 ? 'balanced' : ''}`} aria-live="polite">
            <div><span>{t('totalDebit')}</span><strong>{money.format(totals.debit / 100)}</strong></div>
            <div><span>{t('totalCredit')}</span><strong>{money.format(totals.credit / 100)}</strong></div>
            <div><span>{t('difference')}</span><strong>{money.format(difference / 100)}</strong></div>
            <button className="primary-action" disabled={busy || difference !== 0 || totals.debit === 0 || currentWorkspace?.fiscalYear.status !== 'OPEN'}>{busy ? t('postingBusy') : t('postBinding')}</button>
          </div>
          </fieldset>
        </form>
      </section>
    </BookingDocuments>

      <section className="panel journal-panel">
        <div className="panel-title"><div><span className="step">{t('journal')}</span><h2>{t('postedEntries')}</h2></div><span className="hint">{t('entryCount', { count: currentWorkspace?.entries.length ?? 0 })}</span></div>
        {currentWorkspace && currentWorkspace.entries.length === 0 && <div className="empty"><strong>{t('noBookings')}</strong><p>{t('noBookingsHelp')}</p></div>}
        <div className="journal-list">{currentWorkspace?.entries.map(entry => <article className="journal-entry" key={entry.id}>
          <div className="journal-meta"><span className="sequence">#{String(entry.sequenceNumber).padStart(4, '0')}</span><time>{formatCalendarDate(entry.bookingDate)}</time><span>{entry.documentNumber}</span></div>
          <strong>{entry.description}</strong>
          {entry.documents?.length > 0 && <div className="journal-documents">{entry.documents.map(document => <a key={document.id} href={document.url} target="_blank" rel="noreferrer"><i className="bi bi-paperclip" />{document.fileName || t('unnamedDocument')}</a>)}</div>}
          <div className="journal-lines">{entry.lines.map(line => <div key={line.id}><span>{line.account.number} · {line.account.name}</span><span>{line.debitCents ? `Soll ${money.format(line.debitCents / 100)}` : `Haben ${money.format(line.creditCents / 100)}`}</span></div>)}</div>
        </article>)}</div>
      </section>
  </div>
}

function MoneyInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <div className="money-input"><input aria-label={label} inputMode="decimal" type="number" min="0" step="0.01" value={value} onChange={event => onChange(event.target.value)} /><span>€</span></div>
}
function Metric({ label, value }: { label: string; value: number }) { return <div className="metric"><span>{label}</span><strong>{money.format(value / 100)}</strong></div> }
function toCents(value: string) { const number = Number(value || 0); return Number.isFinite(number) ? Math.round(number * 100) : 0 }
function localDate() { const date = new Date(); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 10) }
function formatCalendarDate(value: string) { const [year, month, day] = value.slice(0, 10).split('-'); return `${day}.${month}.${year}` }
export function shouldApplyWorkspace(requestedYear: number, currentYear: number, aborted: boolean, requestId = 0, currentRequestId = requestId) {
  return !aborted && requestedYear === currentYear && requestId === currentRequestId
}
export function isBookingFormDisabled(busy: boolean, documentsUploading = false, storagePending = false) {
  return busy || documentsUploading || storagePending
}
export function bookingFormRows() { return [['bookingDate', 'documentNumber'], ['description']] as const }

type BookingWorkspaceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function getBrowserBookingWorkspaceStorage(): BookingWorkspaceStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function bookingWorkspaceStorageKey(ownerId: string) {
  return `accounting.bookings.workspace-state.${encodeURIComponent(ownerId)}`
}

export function loadBookingWorkspaceState(storage: BookingWorkspaceStorage, ownerId: string): BookingWorkspaceState | null {
  try {
    return parseBookingWorkspaceState(storage.getItem(bookingWorkspaceStorageKey(ownerId)))
  } catch {
    return null
  }
}

export function saveBookingWorkspaceState(storage: BookingWorkspaceStorage, ownerId: string, state: BookingWorkspaceState) {
  try {
    storage.setItem(bookingWorkspaceStorageKey(ownerId), JSON.stringify(state))
  } catch {
    // Keep the last successfully stored draft when a newer autosave cannot be written.
  }
}

export function persistBookingWorkspaceStateChange(
  storage: BookingWorkspaceStorage,
  ownerId: string,
  currentState: BookingWorkspaceState,
  changes: Partial<BookingWorkspaceState>,
) {
  const nextState = { ...currentState, ...changes }
  saveBookingWorkspaceState(storage, ownerId, nextState)
  return nextState
}

export function clearBookingWorkspaceState(storage: BookingWorkspaceStorage, ownerId: string) {
  try {
    storage.removeItem(bookingWorkspaceStorageKey(ownerId))
    return true
  } catch {
    // localStorage can be unavailable; the posted form is still cleared in memory.
    return false
  }
}

export function consumeBookingWorkspaceSaveSuppression(suppression: { current: boolean }) {
  if (!suppression.current) return false
  suppression.current = false
  return true
}

export function parseBookingWorkspaceState(value: string | null): BookingWorkspaceState | null {
  if (!value) return null
  try {
    const state: unknown = JSON.parse(value)
    if (!isRecord(state)
      || !Number.isInteger(state.year)
      || typeof state.bookingDate !== 'string'
      || typeof state.documentNumber !== 'string'
      || typeof state.description !== 'string'
      || !Array.isArray(state.lines)
      || state.lines.length < 2
      || !state.lines.every(isLine)
      || !Array.isArray(state.selectedDocumentIds)
      || !state.selectedDocumentIds.every(id => typeof id === 'string')) return null
    return state as BookingWorkspaceState
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isLine(value: unknown): value is Line {
  return isRecord(value)
    && typeof value.accountId === 'string'
    && typeof value.debit === 'string'
    && typeof value.credit === 'string'
}
