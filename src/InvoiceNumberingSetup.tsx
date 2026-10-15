'use client'

import { useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { api, getJSON } from './Requester'

export interface InvoiceNumberSequence { year: number; nextValue: number; reconciled: boolean }

export function InvoiceNumberingSetup({ sequences, canManage, onSaved }: {
  sequences: InvoiceNumberSequence[]
  canManage: boolean
  onSaved: () => Promise<void>
}) {
  const t = useTranslations('StructuredInvoices')
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [firstNumber, setFirstNumber] = useState('1')
  const [importedNumbers, setImportedNumbers] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const selected = sequences.find(sequence => sequence.year === Number(year))

  async function reconcile(event: FormEvent) {
    event.preventDefault()
    if (busy || !canManage || !confirmed) return
    setBusy(true); setError(''); setStatus('')
    try {
      const response = await api.post('/api/tax/e-invoices', {
        action: 'reconcile-number-sequence', year: Number(year), firstUnusedNumber: Number(firstNumber),
        importedInvoiceNumbers: importedNumbers.split(/\r?\n/).map(value => value.trim()).filter(Boolean),
        confirmedExistingSeries: confirmed,
      })
      const body = await getJSON(response)
      if (!response.ok || body?.success !== true) throw new Error(body?.issues?.join(' ') || body?.error || t('setupFailed'))
      setStatus(t('sequenceReady')); setConfirmed(false); await onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : t('setupFailed')) }
    finally { setBusy(false) }
  }

  return <section className="card mb-4" aria-labelledby="invoice-numbering-title"><div className="card-body">
    <h2 className="h4" id="invoice-numbering-title">{t('numbering')}</h2>
    {sequences.length ? <ul>{sequences.map(sequence => <li key={sequence.year}>
      {t('sequenceSummary', { year: String(sequence.year), next: sequence.nextValue })}{' '}
      <span className={`badge ${sequence.reconciled ? 'bg-success' : 'bg-warning text-dark'}`}>{t(sequence.reconciled ? 'reconciled' : 'reconciliationRequired')}</span>
    </li>)}</ul> : <p>{t('notConfigured')}</p>}
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {status && <div className="alert alert-success" role="status">{status}</div>}
    {canManage ? <form onSubmit={reconcile} aria-busy={busy}><fieldset disabled={busy}>
      <div className="row g-3">
        <div className="col-sm-4 col-lg-3"><label className="form-label" htmlFor="invoice-year">{t('invoiceYear')}</label>
          <input required className="form-control" id="invoice-year" type="number" min="2000" max="9999" value={year} onChange={event => { setYear(event.target.value); setConfirmed(false); setStatus(''); setError('') }} />
        </div>
        {!selected?.reconciled && <div className="col-sm-8 col-lg-4"><label className="form-label" htmlFor="first-number">{t('firstNumber')}</label>
          <input required className="form-control" id="first-number" type="number" min="1" max="999999" value={firstNumber} onChange={event => { setFirstNumber(event.target.value); setConfirmed(false) }} />
        </div>}
      </div>
      {selected?.reconciled ? <p className="text-muted mt-3 mb-0">{t('reconciliationComplete')}</p> : <>
        <div className="mt-3"><label className="form-label" htmlFor="imported-invoice-numbers">{t('importedNumbers')}</label>
          <textarea className="form-control" id="imported-invoice-numbers" rows={4} aria-describedby="imported-invoice-numbers-help" value={importedNumbers} onChange={event => { setImportedNumbers(event.target.value); setConfirmed(false) }} />
          <div className="form-text" id="imported-invoice-numbers-help">{t('importedNumbersHelp', { year })}</div>
        </div>
        <p className="text-muted mt-3">{t('reconciliationWarning')}</p>
        <div className="form-check mb-3"><input className="form-check-input" id="confirm-number" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><label className="form-check-label" htmlFor="confirm-number">{t('confirmNumber')}</label></div>
        <button disabled={!confirmed} className="btn btn-outline-primary" type="submit">{busy ? t('initializing') : t('initialize')}</button>
        {busy && !status && <span className="visually-hidden" role="status">{t('initializing')}</span>}
      </>}
    </fieldset></form> : <p className="text-muted mb-0">{t('numberingAdministratorRequired')}</p>}
  </div></section>
}
