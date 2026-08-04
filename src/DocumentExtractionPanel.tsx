"use client"

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { getJSON } from './Requester'

type ExtractionData = { supplierName: string; invoiceNumber: string; issueDate: string; netAmountCents: number; taxAmountCents: number; grossAmountCents: number; provenance: string }
type Extraction = { documentId: string; status: string; provider: string; providerVersion: string; inputHash: string; data: ExtractionData | null; failureCode: string | null; failureMessage: string | null; retryable: boolean; reviewedAt: string | null }
type SupplierCreditContext = { correction: null | { id: string; documentNumber: string; openItem: { originalAmountCents: number; allocatedAmountCents: number; status: string }; correctionNetting: { amountCents: number }; postingJournalEntry: { documentNumber: string } }; credit: { kind: string; documentNumber: string; issueDate: string; correctedInvoiceNumber: string; grossAmountCents: number; syntax: string }; original: { id: string; documentNumber: string; supplier: string; remainingAmountCents: number; currency: string } }

export function DocumentExtractionPanel({ documentId }: { documentId: string }) {
  const t = useTranslations('DocumentExtraction')
  const [extraction, setExtraction] = useState<Extraction | null>(null)
  const [form, setForm] = useState<ExtractionData | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [supplierCredit, setSupplierCredit] = useState<SupplierCreditContext | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setExtraction(null); setForm(null); setSupplierCredit(null); setError('')
    void fetch(path(documentId), { signal: controller.signal }).then(async response => {
      if (response.status === 404) return
      const body = await getJSON(response)
      if (!response.ok) throw new Error(body?.error || t('loadFailed'))
      apply(body.data)
    }).catch(fetchError => { if (fetchError?.name !== 'AbortError') setError(fetchError instanceof Error ? fetchError.message : t('loadFailed')) })
    void fetch(creditPath(documentId), { signal: controller.signal }).then(async response => {
      if (response.status === 404) return
      const body = await getJSON(response)
      if (!response.ok) throw new Error(body?.error || t('creditLoadFailed'))
      setSupplierCredit(body.data)
    }).catch(fetchError => { if (fetchError?.name !== 'AbortError') setError(fetchError instanceof Error ? fetchError.message : t('creditLoadFailed')) })
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
    {!extraction && !supplierCredit && <button className="btn btn-outline-primary btn-sm mt-2" type="button" disabled={busy} onClick={extract}>{busy ? t('extracting') : t('extract')}</button>}
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
    {supplierCredit && <IncomingSupplierCreditPosting documentId={documentId} initialContext={supplierCredit} />}
    {error && <div className="alert alert-danger mt-2 mb-0" role="alert">{error}</div>}
  </section>
}

function IncomingSupplierCreditPosting({ documentId, initialContext }: { documentId: string; initialContext: SupplierCreditContext }) {
  const t = useTranslations('DocumentExtraction')
  const [context, setContext] = useState(initialContext)
  const [effectiveDate, setEffectiveDate] = useState('')
  const [reason, setReason] = useState('Reviewed structured supplier credit note and exact original reference')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [requestKey] = useState(() => `supplier-credit-ui-${crypto.randomUUID()}`)
  async function post(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const response = await fetch(creditPath(documentId), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ effectiveDate, requestKey, reason }) })
      const body = await getJSON(response); if (!response.ok) throw new Error(body?.error || t('creditPostingFailed'))
      setContext(current => ({ ...current, correction: body.data }))
    } catch (postingError) { setError(postingError instanceof Error ? postingError.message : t('creditPostingFailed')) }
    finally { setBusy(false) }
  }
  if (context.correction) return <div className="alert alert-success mt-3 mb-0" role="status">{t('creditPosted', { credit: context.correction.documentNumber, journal: context.correction.postingJournalEntry.documentNumber, unapplied: ((context.correction.openItem.originalAmountCents - context.correction.openItem.allocatedAmountCents) / 100).toFixed(2) })}</div>
  return <section className="card mt-3" aria-label={t('creditPostingTitle')}><div className="card-body">
    <h4 className="h6">{t('creditPostingTitle')}</h4><p className="small text-muted">{t('creditPostingHint')}</p>
    <dl className="row small"><dt className="col-sm-4">{t('creditDocument')}</dt><dd className="col-sm-8">{context.credit.syntax} {context.credit.documentNumber}</dd><dt className="col-sm-4">{t('creditOriginal')}</dt><dd className="col-sm-8">{context.original.documentNumber} · {context.original.supplier}</dd><dt className="col-sm-4">{t('creditAmount')}</dt><dd className="col-sm-8">{(context.credit.grossAmountCents / 100).toFixed(2)} {context.original.currency}</dd></dl>
    <form onSubmit={post}><label className="form-label d-block">{t('creditEffectiveDate')}<input className="form-control" type="date" required value={effectiveDate} onChange={event => setEffectiveDate(event.target.value)} /></label><label className="form-label d-block">{t('postingReason')}<input className="form-control" required value={reason} onChange={event => setReason(event.target.value)} /></label><button className="btn btn-primary btn-sm" type="submit" disabled={busy || !effectiveDate}>{busy ? t('posting') : t('postCredit')}</button></form>
    {error && <div className="alert alert-danger mt-2 mb-0" role="alert">{error}</div>}
  </div></section>
}

type ReverseChargeTreatment = null | { kind: 'DE_13B_DOMESTIC' | 'DE_13B_EU_SERVICE'; supportedAssessmentRatesBasisPoints: readonly [1900]; reason: string; configured: boolean }
type PostingContext = { posting: null | { id: string; documentNumber: string; openItem: { id: string; originalAmountCents: number; status: string }; postingJournalEntry: { id: string; documentNumber: string } }; expenseAccounts: Array<{ id: string; number: number; name: string }>; recommendedExpenseAccountId: string | null; reverseChargeTreatment: ReverseChargeTreatment }

export function canPostIncomingPayable(input: { busy: boolean; expenseAccountCount: number; reverseChargeTreatment: ReverseChargeTreatment; reverseChargeRate: string; reverseChargeSupplyKind?: string }) {
  return !input.busy && input.expenseAccountCount > 0 && (!input.reverseChargeTreatment || (input.reverseChargeTreatment.configured && input.reverseChargeRate === '1900' && (input.reverseChargeTreatment.kind !== 'DE_13B_EU_SERVICE' || input.reverseChargeSupplyKind === 'SERVICE')))
}

function IncomingPayablePosting({ documentId, issueDate }: { documentId: string; issueDate: string }) {
  const t = useTranslations('DocumentExtraction')
  const [context, setContext] = useState<PostingContext | null>(null)
  const [expenseAccountId, setExpenseAccountId] = useState('')
  const [dueDate, setDueDate] = useState(() => plusDays(issueDate, 14))
  const [reason, setReason] = useState('Reviewed supplier invoice confirmed for posting')
  const [reverseChargeRate, setReverseChargeRate] = useState('')
  const [reverseChargeSupplyKind, setReverseChargeSupplyKind] = useState('')
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
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expenseAccountId, dueDate, reason, ...(context?.reverseChargeTreatment ? { reverseChargeRateBasisPoints: Number(reverseChargeRate) } : {}), ...(context?.reverseChargeTreatment?.kind === 'DE_13B_EU_SERVICE' ? { reverseChargeSupplyKind } : {}) }) })
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
      {context.reverseChargeTreatment && <div className="alert alert-warning"><strong>{t(context.reverseChargeTreatment.kind === 'DE_13B_EU_SERVICE' ? 'euReverseChargeTitle' : 'reverseChargeTitle')}</strong><p>{t(context.reverseChargeTreatment.kind === 'DE_13B_EU_SERVICE' ? 'euReverseChargeHint' : 'reverseChargeHint')}</p>{context.reverseChargeTreatment.kind === 'DE_13B_EU_SERVICE' && <label className="d-block mb-2">{t('reverseChargeSupplyKind')}<select className="form-select" required value={reverseChargeSupplyKind} onChange={event => setReverseChargeSupplyKind(event.target.value)}><option value="">{t('reverseChargeSupplyKindSelect')}</option><option value="SERVICE">{t('reverseChargeSupplyKindService')}</option></select></label>}<label>{t('reverseChargeRate')}<select className="form-select" required value={reverseChargeRate} onChange={event => setReverseChargeRate(event.target.value)}><option value="">{t('reverseChargeSelect')}</option><option value="1900">19 %</option></select></label>{!context.reverseChargeTreatment.configured && <p className="text-danger mt-2 mb-0">{t('reverseChargeAccountsMissing')}</p>}</div>}
      <button className="btn btn-primary btn-sm" disabled={!canPostIncomingPayable({ busy, expenseAccountCount: context.expenseAccounts.length, reverseChargeTreatment: context.reverseChargeTreatment, reverseChargeRate, reverseChargeSupplyKind })} type="submit">{busy ? t('posting') : t('postPayable')}</button>
      {!context.expenseAccounts.length && <p className="text-danger small mt-2 mb-0">{t('noExpenseAccount')}</p>}
    </form>}
    {error && <div className="alert alert-danger mt-2 mb-0" role="alert">{error}</div>}
  </div></section>
}

function Money({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (value: number) => void }) {
  return <label>{label}<input className="form-control" type="number" step="0.01" min="0" required disabled={disabled} value={(value / 100).toFixed(2)} onChange={event => onChange(Math.round(Number(event.target.value) * 100))} /></label>
}

function path(documentId: string) { return `/api/documents/${encodeURIComponent(documentId)}/parsing-requests` }
function creditPath(documentId: string) { return `/api/documents/${encodeURIComponent(documentId)}/payable-credit-note` }

function plusDays(value: string, days: number) { const date = new Date(`${value}T00:00:00.000Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) }
