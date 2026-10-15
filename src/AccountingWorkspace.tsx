"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { BookingDocuments, type BookingDocument } from './BookingDocuments'
import { AccountSelector } from './AccountSelector'
import { availableBookingAccounts, sanitizeBookingAccountSelections, type AccountCategory } from './core/doubleEntry'
import { LocalDate } from './LocalDate'
import { localizeErrorDates } from './errorFormatting'
import { useRegionalFormat } from './RegionalFormatProvider'
import { LocalCurrency, formatCount } from './LocalNumber'
import { BookingSubmissionError, loadPendingBooking, postSavedBooking, saveBooking, storePendingBooking, type BookingSubmissionMode, type SavedBooking } from './bookingSubmission'

type Account = { id: string; number: number; name: string; category: AccountCategory }
export type VatTreatment = '' | 'DE_STANDARD_SALE_NET' | 'DE_STANDARD_PURCHASE_NET' | 'DE_STANDARD_SALE_GROSS' | 'DE_STANDARD_PURCHASE_GROSS'
type Line = { accountId: string; debit: string; credit: string; vatTreatment?: VatTreatment }
export type JournalEntryLine = {
  id: string
  debitCents: number
  creditCents: number
  account: Pick<Account, 'number' | 'name'>
}
export type JournalDisplayLine = JournalEntryLine & {
  side: 'debit' | 'credit'
  amountCents: number
  connector: boolean
}
export type BookingWorkspaceState = {
  year: number
  bookingDate: string
  description: string
  lines: Line[]
  selectedDocumentIds: string[]
}
type Workspace = {
  fiscalYear: { year: number; status: string }
  accounts: Account[]
  entries: Array<{
    id: string; sequenceNumber: number; bookingDate: string; documentNumber: string; description: string
    sourcePostingDate?: string | null; sourceJournalDate?: string | null; sourcePeriod?: number | null
    lines: Array<JournalEntryLine & { account: Account }>
    documents: BookingDocument[]
  }>
  statements: { assetsCents: number; liabilitiesCents: number; equityCents: number; netIncomeCents: number }
}

const emptyLine = (): Line => ({ accountId: '', debit: '', credit: '' })
export type AccountingWorkspaceView = 'booking' | 'journal' | 'dashboard'

export function AccountingWorkspace({ ownerId, view = 'booking', initialYear = new Date().getFullYear(), restoreStoredYear = true }: {
  ownerId: string
  view?: AccountingWorkspaceView
  initialYear?: number
  restoreStoredYear?: boolean
}) {
  const t = useTranslations('Workspaces')
  const { locale: regionalLocale } = useRegionalFormat()
  const [year, setYear] = useState(initialYear)
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()])
  const [bookingDate, setBookingDate] = useState(localDate)
  const [description, setDescription] = useState('')
  const [issues, setIssues] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState('')
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([])
  const [unavailableDocumentIds, setUnavailableDocumentIds] = useState<string[]>([])
  const [continueWithSameDocuments, setContinueWithSameDocuments] = useState(defaultContinueWithSameDocuments)
  const [documentsUploading, setDocumentsUploading] = useState(false)
  const [storageRestored, setStorageRestored] = useState(false)
  const [submissionMode, setSubmissionMode] = useState<BookingSubmissionMode>('post')
  const [pendingBooking, setPendingBooking] = useState<SavedBooking | null>(null)
  const submittingRef = useRef(false)
  const yearRef = useRef(year)
  const loadRef = useRef(0)
  const suppressNextDraftSaveRef = useRef(false)
  const bookingWorkspaceStateRef = useRef<BookingWorkspaceState>({
    year, bookingDate, description, lines, selectedDocumentIds,
  })
  bookingWorkspaceStateRef.current = {
    year, bookingDate, description, lines, selectedDocumentIds,
  }

  useEffect(() => {
    if (view !== 'booking') {
      setStorageRestored(true)
      return
    }
    const storage = getBrowserBookingWorkspaceStorage()
    const saved = storage ? loadBookingWorkspaceState(storage, ownerId) : null
    if (saved) {
      bookingWorkspaceStateRef.current = saved
      if (restoreStoredYear) setYear(saved.year)
      const targetYear = restoreStoredYear ? saved.year : initialYear
      setBookingDate(saved.bookingDate.startsWith(`${targetYear}-`) ? saved.bookingDate : `${targetYear}-01-01`)
      setDescription(saved.description)
      setLines(saved.lines)
      setSelectedDocumentIds(saved.selectedDocumentIds)
    }
    setStorageRestored(true)
  }, [initialYear, ownerId, restoreStoredYear, view])

  useEffect(() => {
    if (view === 'booking') setPendingBooking(loadPendingBooking(getBrowserBookingWorkspaceStorage(), ownerId, year))
  }, [ownerId, year, view])

  useEffect(() => {
    if (!storageRestored || view !== 'booking') return
    if (consumeBookingWorkspaceSaveSuppression(suppressNextDraftSaveRef)) return
    const storage = getBrowserBookingWorkspaceStorage()
    if (!storage) return
    saveBookingWorkspaceState(storage, ownerId, {
      year, bookingDate, description, lines, selectedDocumentIds,
    })
  }, [storageRestored, ownerId, year, bookingDate, description, lines, selectedDocumentIds, view])

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
  const postingLineRemovalClass = shouldShowPostingLineRemoveButtons(lines.length) ? '' : ' remove-buttons-hidden'

  function updateLine(index: number, field: keyof Line, value: string) {
    setLines(current => {
      const updated = current.map((line, lineIndex) => lineIndex === index
      ? { ...line, [field]: value, ...(field === 'debit' && value ? { credit: '' } : {}), ...(field === 'credit' && value ? { debit: '' } : {}) }
      : line)
      return field === 'accountId' && currentWorkspace
        ? sanitizeBookingAccountSelections(currentWorkspace.accounts, updated)
        : updated
    })
  }

  function updateDescription(value: string) {
    setDescription(value)
    if (!storageRestored) return
    const storage = getBrowserBookingWorkspaceStorage()
    if (storage) bookingWorkspaceStateRef.current = persistBookingWorkspaceStateChange(
      storage, ownerId, bookingWorkspaceStateRef.current, { description: value },
    )
  }

  function clearForm(posted: boolean) {
    const documentState = documentStateAfterPosting(selectedDocumentIds, continueWithSameDocuments)
    const storage = getBrowserBookingWorkspaceStorage()
    storePendingBooking(storage, ownerId, year, null)
    setPendingBooking(null)
    suppressNextDraftSaveRef.current = storage ? clearBookingWorkspaceState(storage, ownerId) : false
    const clearedLines = [emptyLine(), emptyLine()]
    bookingWorkspaceStateRef.current = {
      ...bookingWorkspaceStateRef.current, lines: clearedLines, description: '', selectedDocumentIds: documentState.selectedDocumentIds,
    }
    setLines(clearedLines); setDescription(''); setSelectedDocumentIds(documentState.selectedDocumentIds)
    if (posted) setUnavailableDocumentIds(current => [...new Set([...current, ...documentState.unavailableDocumentIds])])
  }

  async function post(event?: React.FormEvent) {
    event?.preventDefault()
    if (submittingRef.current || documentsUploading) return
    if (!pendingBooking && (!workspace || workspace.fiscalYear.year !== year)) { setIssues([t('bookingsLoadFailed')]); return }
    submittingRef.current = true
    setBusy(true); setIssues([]); setSuccess('')
    const submittedYear = year
    const postImmediately = Boolean(pendingBooking) || submissionMode === 'post'
    try {
      const saved = pendingBooking ?? await saveBooking({ fiscalYear: year, bookingDate, description, documentIds: selectedDocumentIds, lines: lines.map(bookingLineRequest) }, t('draftSaveFailed'))
      if (postImmediately) {
        if (yearRef.current === submittedYear) setPendingBooking(saved)
        if (!storePendingBooking(getBrowserBookingWorkspaceStorage(), ownerId, submittedYear, saved)) throw new BookingSubmissionError([t('postingRecoveryUnavailable')])
        await postSavedBooking(saved, t('postingFailed'))
        storePendingBooking(getBrowserBookingWorkspaceStorage(), ownerId, submittedYear, null)
      }
      if (yearRef.current === submittedYear) {
        clearForm(postImmediately)
        setSuccess(t(postImmediately ? 'postingSaved' : 'draftSaved')); await load()
      }
    } catch (error) { if (yearRef.current === submittedYear) setIssues(error instanceof BookingSubmissionError ? error.issues : [t(postImmediately ? 'postingFailed' : 'draftSaveFailed')]) }
    finally { submittingRef.current = false; if (yearRef.current === submittedYear) setBusy(false) }
  }

  const sections = workspaceSections(view)

  return <div className={`workspace ${view === 'booking' ? 'bookings-workspace' : `${view}-workspace`} pb-4`}>
    {sections.metrics && currentWorkspace && <section className="metric-grid" aria-label={t('metrics')}>
      <Metric label={t('assets')} value={currentWorkspace.statements.assetsCents} />
      <Metric label={t('liabilitiesEquity')} value={currentWorkspace.statements.liabilitiesCents + currentWorkspace.statements.equityCents} />
      <Metric label={t('provisionalResult')} value={currentWorkspace.statements.netIncomeCents} />
      <div className="card metric"><span>{t('status')}</span><strong className={`badge status ${currentWorkspace.fiscalYear.status.toLowerCase()}`}>{currentWorkspace.fiscalYear.status === 'OPEN' ? t('open') : t('locked')}</strong></div>
    </section>}

    {sections.booking && pendingBooking && <section className="card panel">
      <h2 className="h5">{t('pendingPosting')}</h2>
      <p>{t('pendingPostingHelp')}</p>
      {issues.length > 0 && <div className="alert alert-danger" role="alert">{issues.map(issue => <p className="mb-0" key={issue}>{localizeErrorDates(issue, regionalLocale)}</p>)}</div>}
      <div className="d-flex flex-wrap gap-2">
        <button className="btn btn-primary" disabled={busy} onClick={() => void post()}>{busy ? t('postingBusy') : t('retryPosting')}</button>
        {!busy && <a className="btn btn-outline-secondary" href={`/booking-batches?year=${year}`} onClick={() => clearForm(false)}>{t('reviewBookingBatches')}</a>}
        <a className="btn btn-link" href={`/journal?year=${year}`}>{t('viewJournal')}</a>
      </div>
    </section>}
    {sections.booking && !pendingBooking && <BookingDocuments selectedDocumentIds={selectedDocumentIds} unavailableDocumentIds={unavailableDocumentIds} onSelectionChange={setSelectedDocumentIds} onUploadingChange={setDocumentsUploading}>
      <section className="card panel booking-panel">
        <div className="panel-title"><h2>{t('recordTransaction')}</h2></div>
        <form onSubmit={post}>
          <fieldset disabled={isBookingFormDisabled(busy, documentsUploading, !storageRestored)}>
          <div className="form-grid booking-metadata-row">
            <label>{t('postingDate')}<input className="form-control" required type="date" value={bookingDate} onChange={event => setBookingDate(event.target.value)} /></label>
          </div>
          <div className="form-grid booking-description-row">
            <label>{t('postingText')}<input className="form-control" required value={description} onChange={event => updateDescription(event.target.value)} /></label>
          </div>
          <div className={`posting-grid${postingLineRemovalClass}`}>
            <div className="posting-head"><span>{t('account')}</span><span>{t('debit')}</span><span>{t('credit')}</span><span>{t('vatTreatment')}</span><span /></div>
            {lines.map((line, index) => {
              const availableAccounts = availableBookingAccounts(currentWorkspace?.accounts ?? [], lines, index)
              return <div className="posting-line" key={index}>
              <AccountSelector
                accounts={availableAccounts}
                value={line.accountId}
                label={t('accountLine', { line: index + 1 })}
                chooseLabel={t('chooseAccount')}
                searchLabel={t('searchAccounts')}
                noResultsLabel={t('noMatchingAccounts')}
                balanceSheetLabel={t('balanceSheetAccounts')}
                profitAndLossLabel={t('profitAndLossAccounts')}
                onChange={value => updateLine(index, 'accountId', value)}
              />
              <MoneyInput label={t('debitLine', { line: index + 1 })} value={line.debit} onChange={value => updateLine(index, 'debit', value)} />
              <MoneyInput label={t('creditLine', { line: index + 1 })} value={line.credit} onChange={value => updateLine(index, 'credit', value)} />
              <select
                className="form-select"
                aria-label={t('vatLine', { line: index + 1 })}
                value={line.vatTreatment ?? ''}
                onChange={event => updateLine(index, 'vatTreatment', event.target.value as VatTreatment)}
              >
                <option value="">{t('vatNone')}</option>
                <option value="DE_STANDARD_SALE_NET">{t('vatStandardSaleNet')}</option>
                <option value="DE_STANDARD_PURCHASE_NET">{t('vatStandardPurchaseNet')}</option>
                <option value="DE_STANDARD_SALE_GROSS">{t('vatStandardSaleGross')}</option>
                <option value="DE_STANDARD_PURCHASE_GROSS">{t('vatStandardPurchaseGross')}</option>
              </select>
              <button type="button" className="btn btn-light icon-button" aria-label={t('removeLine', { line: index + 1 })} onClick={() => setLines(current => current.filter((_, i) => i !== index))}>×</button>
            </div>})}
          </div>
          <button className="btn btn-link add-line" type="button" onClick={() => setLines(current => [...current, emptyLine()])}>+ {t('addSplitLine')}</button>
          {issues.length > 0 && <div className="alert alert-danger" role="alert"><strong>{t('pleaseReview')}</strong><ul>{issues.map(issue => <li key={issue}>{localizeErrorDates(issue, regionalLocale)}</li>)}</ul></div>}
          {success && <p className="alert alert-success" role="status">{success} {submissionMode === 'draft' && <a href={`/booking-batches?year=${year}`}>{t('reviewBookingBatches')}</a>}</p>}
          <fieldset className="mb-3">
            <legend className="fs-6">{t('bookingWorkflow')}</legend>
            <label className="form-check">
              <input className="form-check-input" type="radio" name="booking-workflow" value="post" aria-describedby="booking-workflow-help" checked={submissionMode === 'post'} onChange={() => setSubmissionMode('post')} />
              <span className="form-check-label">{t('postImmediately')}</span>
            </label>
            <label className="form-check">
              <input className="form-check-input" type="radio" name="booking-workflow" value="draft" aria-describedby="booking-workflow-help" checked={submissionMode === 'draft'} onChange={() => setSubmissionMode('draft')} />
              <span className="form-check-label">{t('saveToBatch')}</span>
            </label>
            <p id="booking-workflow-help" className="form-text mb-0" aria-live="polite">{t(submissionMode === 'post' ? 'postImmediatelyHelp' : 'saveToBatchHelp')}</p>
          </fieldset>
          <label className="form-check">
            <input className="form-check-input" type="checkbox" checked={continueWithSameDocuments} onChange={event => setContinueWithSameDocuments(event.target.checked)} />
            <span className="form-check-label">{t('continueWithSameDocuments')}</span>
          </label>
          <div className={`balance-bar ${difference === 0 && totals.debit > 0 ? 'balanced' : ''}`} aria-live="polite">
            <div><span>{t('totalDebit')}</span><strong><LocalCurrency cents={totals.debit} currency="EUR" /></strong></div>
            <div><span>{t('totalCredit')}</span><strong><LocalCurrency cents={totals.credit} currency="EUR" /></strong></div>
            <div><span>{t('difference')}</span><strong><LocalCurrency cents={difference} currency="EUR" /></strong></div>
            <button className="btn btn-primary" disabled={busy || selectedDocumentIds.length === 0 || difference !== 0 || totals.debit === 0 || currentWorkspace?.fiscalYear.status !== 'OPEN'}>{busy ? t('postingBusy') : t(submissionMode === 'post' ? 'post' : 'saveToBatch')}</button>
          </div>
          </fieldset>
        </form>
      </section>
    </BookingDocuments>}

      {sections.journal && <section className="card panel journal-panel">
        <div className="panel-title"><h2>{t('postedEntries')}</h2><span className="badge text-bg-light hint">{(() => { const count = currentWorkspace?.entries.length ?? 0; return t('entryCount', { count, countFormatted: formatCount(count, regionalLocale) }) })()}</span></div>
        {currentWorkspace && currentWorkspace.entries.length === 0 && <div className="empty"><strong>{t('noBookings')}</strong><p>{t('noBookingsHelp')}</p></div>}
        <div className="journal-list">{currentWorkspace?.entries.map(entry => <article className="journal-entry" id={`journal-entry-${entry.id}`} key={entry.id}>
          <div className="journal-meta"><span className="sequence">#{String(entry.sequenceNumber).padStart(4, '0')}</span><span>{entry.documentNumber}</span>{journalEntrySourceMetadata(entry).map((item, index) => item.label
            ? <span key={item.label}>{t(item.label)}: {item.date ? <LocalDate value={item.date} /> : item.value}</span>
            : <span key={index}>{item.date ? <LocalDate value={item.date} /> : item.value}</span>)}</div>
          <strong>{entry.description}</strong>
          {entry.documents?.length > 0 && <div className="journal-documents">{entry.documents.map(document => <a key={document.id} href={document.url} target="_blank" rel="noreferrer"><i className="bi bi-paperclip" />{document.fileName || t('unnamedDocument')}</a>)}</div>}
          <div className="journal-lines" role="list" aria-label={t('journal')}>
            {journalEntryDisplayLines(entry.lines).map(line => <div key={line.id} role="listitem">
              <span>
                {line.connector && <span className="journal-connector">{t('journalConnector')}</span>}
                <span>{line.account.number} · {line.account.name}</span>
              </span>
              <span><span className="visually-hidden">{line.side === 'debit' ? t('debit') : t('credit')}: </span><LocalCurrency cents={line.amountCents} currency="EUR" /></span>
            </div>)}
          </div>
        </article>)}</div>
      </section>}
  </div>
}

function MoneyInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="posting-money-field"><span className="posting-money-label">{label}</span><div className="input-group money-input"><input className="form-control" aria-label={label} inputMode="decimal" type="number" min="0" step="0.01" value={value} onChange={event => onChange(event.target.value)} /><span className="input-group-text">€</span></div></label>
}
function Metric({ label, value }: { label: string; value: number }) { return <div className="card metric"><span>{label}</span><strong><LocalCurrency cents={value} currency="EUR" /></strong></div> }
function toCents(value: string) { const number = Number(value || 0); return Number.isFinite(number) ? Math.round(number * 100) : 0 }
export function bookingLineRequest(line: Line) {
  const treatment = line.vatTreatment ?? ''
  const vat = treatment ? {
    ruleId: 'DE_STANDARD',
    mode: treatment.endsWith('_GROSS') ? 'gross' as const : 'net' as const,
    direction: treatment.includes('_PURCHASE_') ? 'purchase' as const : 'sale' as const,
  } : undefined
  return {
    accountId: line.accountId,
    debitCents: toCents(line.debit),
    creditCents: toCents(line.credit),
    ...(vat ? { vat } : {}),
  }
}
function localDate() { const date = new Date(); const offset = date.getTimezoneOffset() * 60_000; return new Date(date.getTime() - offset).toISOString().slice(0, 10) }
export function journalEntryDisplayLines(lines: readonly JournalEntryLine[]): JournalDisplayLine[] {
  const debitLines: JournalDisplayLine[] = []
  const creditLines: JournalDisplayLine[] = []

  for (const line of lines) {
    if (line.debitCents !== 0) debitLines.push({
      ...line,
      side: 'debit',
      amountCents: line.debitCents,
      connector: false,
      id: `${line.id}:debit`,
    })
    if (line.creditCents !== 0) creditLines.push({
      ...line,
      side: 'credit',
      amountCents: line.creditCents,
      connector: true,
      id: `${line.id}:credit`,
    })
  }

  return [...debitLines, ...creditLines]
}
export function journalEntrySourceMetadata(entry: {
  bookingDate: string
  sourcePostingDate?: string | null
  sourceJournalDate?: string | null
  sourcePeriod?: number | null
}) {
  const isLexwareEntry = Boolean(entry.sourcePostingDate || entry.sourceJournalDate || entry.sourcePeriod !== null && entry.sourcePeriod !== undefined)
  if (!isLexwareEntry) return [{ label: null, value: entry.bookingDate, date: entry.bookingDate }]
  return [
    { label: 'sourcePostingDate', value: entry.sourcePostingDate ?? '—', date: entry.sourcePostingDate ?? undefined },
    { label: 'sourceJournalDate', value: entry.sourceJournalDate ?? '—', date: entry.sourceJournalDate ?? undefined },
    { label: 'voucherDate', value: entry.bookingDate, date: entry.bookingDate },
    { label: 'sourcePeriod', value: entry.sourcePeriod ?? '—', date: undefined },
  ]
}
export function shouldApplyWorkspace(requestedYear: number, currentYear: number, aborted: boolean, requestId = 0, currentRequestId = requestId) {
  return !aborted && requestedYear === currentYear && requestId === currentRequestId
}
export function isBookingFormDisabled(busy: boolean, documentsUploading = false, storagePending = false) {
  return busy || documentsUploading || storagePending
}

export function shouldShowPostingLineRemoveButtons(lineCount: number) {
  return lineCount > 2
}

export const defaultContinueWithSameDocuments = false

export function documentStateAfterPosting(selectedDocumentIds: string[], continueWithSameDocuments: boolean) {
  return continueWithSameDocuments
    ? { selectedDocumentIds: [...selectedDocumentIds], unavailableDocumentIds: [] as string[] }
    : { selectedDocumentIds: [] as string[], unavailableDocumentIds: [...selectedDocumentIds] }
}
export function bookingFormRows() { return [['bookingDate'], ['description']] as const }

export function workspaceSections(view: AccountingWorkspaceView) {
  return {
    booking: view === 'booking',
    journal: view === 'journal',
    metrics: view === 'dashboard',
  }
}

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
      || typeof state.description !== 'string'
      || !Array.isArray(state.lines)
      || state.lines.length < 2
      || !state.lines.every(isLine)
      || !Array.isArray(state.selectedDocumentIds)
      || !state.selectedDocumentIds.every(id => typeof id === 'string')) return null
    return {
      year: state.year,
      bookingDate: state.bookingDate,
      description: state.description,
      lines: state.lines,
      selectedDocumentIds: state.selectedDocumentIds,
    } as BookingWorkspaceState
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
    && (value.vatTreatment === undefined || ['', 'DE_STANDARD_SALE_NET', 'DE_STANDARD_PURCHASE_NET', 'DE_STANDARD_SALE_GROSS', 'DE_STANDARD_PURCHASE_GROSS'].includes(String(value.vatTreatment)))
}
