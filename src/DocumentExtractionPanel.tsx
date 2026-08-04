"use client"

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { getJSON } from './Requester'

type ExtractionData = { supplierName: string; invoiceNumber: string; issueDate: string; netAmountCents: number; taxAmountCents: number; grossAmountCents: number; provenance: string }
type Extraction = { documentId: string; status: string; provider: string; providerVersion: string; inputHash: string; data: ExtractionData | null; failureCode: string | null; failureMessage: string | null; retryable: boolean; reviewedAt: string | null }

export function DocumentExtractionPanel({ documentId }: { documentId: string }) {
  const t = useTranslations('DocumentExtraction')
  const [extraction, setExtraction] = useState<Extraction | null>(null)
  const [form, setForm] = useState<ExtractionData | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setExtraction(null); setForm(null); setError('')
    void fetch(path(documentId), { signal: controller.signal }).then(async response => {
      if (response.status === 404) return
      const body = await getJSON(response)
      if (!response.ok) throw new Error(body?.error || t('loadFailed'))
      apply(body.data)
    }).catch(fetchError => { if (fetchError?.name !== 'AbortError') setError(fetchError instanceof Error ? fetchError.message : t('loadFailed')) })
    return () => controller.abort()
  }, [documentId, t])

  function apply(next: Extraction) { setExtraction(next); setForm(next.data) }

  async function extract() {
    setBusy(true); setError('')
    try {
      const response = await fetch(path(documentId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      const body = await getJSON(response)
      if (!response.ok) throw new Error(body?.error || t('extractFailed'))
      apply(body.data)
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('extractFailed')) }
    finally { setBusy(false) }
  }

  async function confirm(event: React.FormEvent) {
    event.preventDefault(); if (!form) return
    setBusy(true); setError('')
    try {
      const response = await fetch(path(documentId), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(form) })
      const body = await getJSON(response)
      if (!response.ok) throw new Error(body?.error || t('confirmFailed'))
      apply(body.data)
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('confirmFailed')) }
    finally { setBusy(false) }
  }

  return <section className="document-extraction" aria-label={t('title')}>
    <div className="d-flex justify-content-between align-items-center gap-2 mt-3"><h3 className="h6 mb-0">{t('title')}</h3>{extraction && <span className="badge text-bg-light">{t(`status.${extraction.status}`)}</span>}</div>
    {!extraction && <button className="btn btn-outline-primary btn-sm mt-2" type="button" disabled={busy} onClick={extract}>{busy ? t('extracting') : t('extract')}</button>}
    {extraction?.status === 'FAILED' && <div className="alert alert-warning mt-2 mb-0"><strong>{extraction.failureCode}</strong><div>{extraction.failureMessage}</div>{extraction.retryable && <button className="btn btn-outline-primary btn-sm mt-2" type="button" disabled={busy} onClick={extract}>{t('retry')}</button>}</div>}
    {form && <form className="mt-2" onSubmit={confirm}>
      <div className="form-grid">
        <label>{t('supplier')}<input className="form-control" required disabled={busy || extraction?.status === 'CONFIRMED' || extraction?.provider === 'structured-invoice'} value={form.supplierName} onChange={event => setForm({ ...form, supplierName: event.target.value })} /></label>
        <label>{t('invoiceNumber')}<input className="form-control" required disabled={busy || extraction?.status === 'CONFIRMED' || extraction?.provider === 'structured-invoice'} value={form.invoiceNumber} onChange={event => setForm({ ...form, invoiceNumber: event.target.value })} /></label>
        <label>{t('issueDate')}<input className="form-control" required type="date" disabled={busy || extraction?.status === 'CONFIRMED' || extraction?.provider === 'structured-invoice'} value={form.issueDate} onChange={event => setForm({ ...form, issueDate: event.target.value })} /></label>
        <Money label={t('net')} value={form.netAmountCents} disabled={busy || extraction?.status === 'CONFIRMED' || extraction?.provider === 'structured-invoice'} onChange={netAmountCents => setForm({ ...form, netAmountCents })} />
        <Money label={t('tax')} value={form.taxAmountCents} disabled={busy || extraction?.status === 'CONFIRMED' || extraction?.provider === 'structured-invoice'} onChange={taxAmountCents => setForm({ ...form, taxAmountCents })} />
        <Money label={t('gross')} value={form.grossAmountCents} disabled={busy || extraction?.status === 'CONFIRMED' || extraction?.provider === 'structured-invoice'} onChange={grossAmountCents => setForm({ ...form, grossAmountCents })} />
      </div>
      {extraction?.status === 'NEEDS_REVIEW' && <button className="btn btn-primary btn-sm mt-2" disabled={busy} type="submit">{busy ? t('confirming') : t('confirm')}</button>}
      <small className="d-block text-muted mt-2">{t('provenance', { provider: extraction?.provider ?? '', version: extraction?.providerVersion ?? '', hash: extraction?.inputHash.slice(0, 12) ?? '' })}</small>
    </form>}
    {extraction?.status === 'CONFIRMED' && form && <IncomingPayablePosting documentId={documentId} issueDate={form.issueDate} />}
    {error && <div className="alert alert-danger mt-2 mb-0" role="alert">{error}</div>}
  </section>
}

type ReverseChargeTreatment = null | { kind: 'DE_13B_DOMESTIC'; supportedAssessmentRatesBasisPoints: readonly [1900]; reason: string; configured: boolean }
type PostingContext = { posting: null | { id: string; documentNumber: string; openItem: { id: string; originalAmountCents: number; status: string }; postingJournalEntry: { id: string; documentNumber: string } }; expenseAccounts: Array<{ id: string; number: number; name: string }>; recommendedExpenseAccountId: string | null; reverseChargeTreatment: ReverseChargeTreatment }

export function canPostIncomingPayable(input: { busy: boolean; expenseAccountCount: number; reverseChargeTreatment: ReverseChargeTreatment; reverseChargeRate: string }) {
  return !input.busy && input.expenseAccountCount > 0 && (!input.reverseChargeTreatment || (input.reverseChargeTreatment.configured && input.reverseChargeRate === '1900'))
}

function IncomingPayablePosting({ documentId, issueDate }: { documentId: string; issueDate: string }) {
  const t = useTranslations('DocumentExtraction')
  const [context, setContext] = useState<PostingContext | null>(null)
  const [expenseAccountId, setExpenseAccountId] = useState('')
  const [dueDate, setDueDate] = useState(() => plusDays(issueDate, 14))
  const [reason, setReason] = useState('Reviewed supplier invoice confirmed for posting')
  const [reverseChargeRate, setReverseChargeRate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const endpoint = `${path(documentId).replace('/parsing-requests', '')}/payable-posting`

  useEffect(() => {
    const controller = new AbortController()
    void fetch(endpoint, { signal: controller.signal }).then(async response => {
      const body = await getJSON(response)
      if (!response.ok) throw new Error(body?.error || t('postingLoadFailed'))
      setContext(body.data); setExpenseAccountId(body.data.recommendedExpenseAccountId ?? '')
    }).catch(loadError => { if (loadError?.name !== 'AbortError') setError(loadError instanceof Error ? loadError.message : t('postingLoadFailed')) })
    return () => controller.abort()
  }, [endpoint, t])

  async function post(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expenseAccountId, dueDate, reason, ...(context?.reverseChargeTreatment ? { reverseChargeRateBasisPoints: Number(reverseChargeRate) } : {}) }) })
      const body = await getJSON(response)
      if (!response.ok) throw new Error(body?.error || t('postingFailed'))
      setContext(current => current ? { ...current, posting: body.data } : current)
    } catch (postingError) { setError(postingError instanceof Error ? postingError.message : t('postingFailed')) }
    finally { setBusy(false) }
  }

  if (context?.posting) return <div className="alert alert-success mt-3 mb-0" role="status">{t('posted', { invoice: context.posting.documentNumber, journal: context.posting.postingJournalEntry.documentNumber })}</div>
  return <section className="card mt-3" aria-label={t('postingTitle')}><div className="card-body">
    <h4 className="h6">{t('postingTitle')}</h4><p className="small text-muted">{t('postingHint')}</p>
    {context && <form onSubmit={post}>
      <label className="form-label d-block">{t('expenseAccount')}<select className="form-select" required value={expenseAccountId} onChange={event => setExpenseAccountId(event.target.value)}><option value="">{t('selectExpenseAccount')}</option>{context.expenseAccounts.map(account => <option key={account.id} value={account.id}>{account.number} {account.name}</option>)}</select></label>
      <label className="form-label d-block">{t('dueDate')}<input className="form-control" type="date" required min={issueDate} value={dueDate} onChange={event => setDueDate(event.target.value)} /></label>
      <label className="form-label d-block">{t('postingReason')}<input className="form-control" required value={reason} onChange={event => setReason(event.target.value)} /></label>
      {context.reverseChargeTreatment && <div className="alert alert-warning"><strong>{t('reverseChargeTitle')}</strong><p>{t('reverseChargeHint')}</p><label>{t('reverseChargeRate')}<select className="form-select" required value={reverseChargeRate} onChange={event => setReverseChargeRate(event.target.value)}><option value="">{t('reverseChargeSelect')}</option><option value="1900">19 %</option></select></label>{!context.reverseChargeTreatment.configured && <p className="text-danger mt-2 mb-0">{t('reverseChargeAccountsMissing')}</p>}</div>}
      <button className="btn btn-primary btn-sm" disabled={!canPostIncomingPayable({ busy, expenseAccountCount: context.expenseAccounts.length, reverseChargeTreatment: context.reverseChargeTreatment, reverseChargeRate })} type="submit">{busy ? t('posting') : t('postPayable')}</button>
      {!context.expenseAccounts.length && <p className="text-danger small mt-2 mb-0">{t('noExpenseAccount')}</p>}
    </form>}
    {error && <div className="alert alert-danger mt-2 mb-0" role="alert">{error}</div>}
  </div></section>
}

function Money({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (value: number) => void }) {
  return <label>{label}<input className="form-control" type="number" step="0.01" min="0" required disabled={disabled} value={(value / 100).toFixed(2)} onChange={event => onChange(Math.round(Number(event.target.value) * 100))} /></label>
}

function path(documentId: string) { return `/api/documents/${encodeURIComponent(documentId)}/parsing-requests` }

function plusDays(value: string, days: number) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) }
