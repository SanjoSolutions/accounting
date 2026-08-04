"use client"

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { api, getJSON } from './Requester'

export interface PartnerSummary { id: string; partnerNumber: string; role: 'CUSTOMER' | 'SUPPLIER' | 'BOTH'; name: string; countryCode: string; paymentTermDays: number }
export interface OpenItemSummary { id: string; status: 'OPEN' | 'PARTIAL' | 'SETTLED'; currency: string; originalAmountCents: number; allocatedAmountCents: number; commercialDocument: { documentNumber: string; dueDate: string; direction: string; kind: string; businessPartner: { name: string } } }
export interface ReminderSummary { id: string; openItemId: string; level: number; issuedOn: string; paymentDueDate: string; remainingAmountCents: number; currency: string; invoiceNumber: string; cancellation: null | { cancelledOn: string; reason: string }; deliveryAttempts: Array<{ id: string; recipient: string; requestedAt: string; result: null | { status: 'SENT' | 'FAILED'; providerMessageId: string | null; failureCode: string | null; failureMessage: string | null; respondedAt: string } }> }

export async function readCommercialList<T>(response: Response): Promise<T[]> {
  const body = await getJSON(response)
  if (!response.ok || !body || body.success !== true || !Array.isArray(body.data)) throw new Error(typeof body?.error === 'string' ? body.error : 'Commercial data could not be loaded.')
  return body.data as T[]
}

export function formatMinorUnits(amount: number, currency: string, locale = 'de-DE') {
  if (!Number.isSafeInteger(amount) || !/^[A-Z]{3}$/.test(currency)) throw new Error('A safe minor-unit amount and ISO currency are required.')
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 100)
}

export function CommercialWorkspace() {
  const t = useTranslations('Commercial')
  const locale = useLocale()
  const [partners, setPartners] = useState<PartnerSummary[]>([])
  const [openItems, setOpenItems] = useState<OpenItemSummary[]>([])
  const [reminders, setReminders] = useState<ReminderSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [partnerNumber, setPartnerNumber] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState<PartnerSummary['role']>('CUSTOMER')
  const [paymentTermDays, setPaymentTermDays] = useState('14')
  const [deliveryReminderId, setDeliveryReminderId] = useState('')
  const [deliveryRecipient, setDeliveryRecipient] = useState('')
  const [deliveryReason, setDeliveryReason] = useState('')
  const [deliveryApproved, setDeliveryApproved] = useState(false)

  const load = useCallback(async () => {
    setError('')
    try {
      const [partnerRows, itemRows, reminderRows] = await Promise.all([
        readCommercialList<PartnerSummary>(await api.get('/api/commercial/partners')),
        readCommercialList<OpenItemSummary>(await api.get('/api/commercial/open-items')),
        readCommercialList<ReminderSummary>(await api.get('/api/commercial/reminders')),
      ])
      setPartners(partnerRows); setOpenItems(itemRows); setReminders(reminderRows)
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : t('loadFailed')) }
    finally { setLoading(false) }
  }, [t])

  useEffect(() => { void load() }, [load])

  async function submitPartner(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setStatus('')
    try {
      const response = await api.post('/api/commercial/partners', { partnerNumber, role, name, countryCode: 'DE', paymentTermDays: Number(paymentTermDays) })
      const body = await getJSON(response)
      if (!response.ok || body?.success !== true) throw new Error(typeof body?.error === 'string' ? body.error : t('createFailed'))
      setPartnerNumber(''); setName(''); setRole('CUSTOMER'); setPaymentTermDays('14'); setStatus(t('created')); await load()
    } catch (submitError) { setError(submitError instanceof Error ? submitError.message : t('createFailed')) }
    finally { setBusy(false) }
  }

  async function issueReminder(item: OpenItemSummary) {
    setBusy(true); setError(''); setStatus('')
    try {
      const issuedOn = new Date().toISOString().slice(0, 10); const due = new Date(`${issuedOn}T00:00:00.000Z`); due.setUTCDate(due.getUTCDate() + 7)
      const response = await api.post('/api/commercial/reminders', { requestKey: crypto.randomUUID(), openItemId: item.id, issuedOn, paymentDueDate: due.toISOString().slice(0, 10), reason: 'Manual receivables reminder approved in customer workspace' })
      const body = await getJSON(response); if (!response.ok || body?.success !== true) throw new Error(typeof body?.error === 'string' ? body.error : t('reminderFailed'))
      setStatus(t('reminderIssued', { level: body.data.level })); await load()
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : t('reminderFailed')) } finally { setBusy(false) }
  }

  async function cancelReminder(reminder: ReminderSummary) {
    setBusy(true); setError(''); setStatus('')
    try {
      const response = await api.post(`/api/commercial/reminders/${reminder.id}/cancellations`, { requestKey: crypto.randomUUID(), cancelledOn: new Date().toISOString().slice(0, 10), reason: 'Manually cancelled in customer workspace' })
      const body = await getJSON(response); if (!response.ok || body?.success !== true) throw new Error(typeof body?.error === 'string' ? body.error : t('cancelFailed'))
      setStatus(t('reminderCancelled')); await load()
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : t('cancelFailed')) } finally { setBusy(false) }
  }

  function prepareDelivery(reminderId: string) {
    setDeliveryReminderId(reminderId); setDeliveryRecipient(''); setDeliveryReason(''); setDeliveryApproved(false); setError(''); setStatus('')
  }

  async function sendReminder(event: FormEvent, reminder: ReminderSummary) {
    event.preventDefault(); if (!deliveryApproved) return
    setBusy(true); setError(''); setStatus('')
    try {
      const response = await api.post(`/api/commercial/reminders/${reminder.id}/deliveries`, { requestKey: crypto.randomUUID(), recipient: deliveryRecipient, reason: deliveryReason })
      const body = await getJSON(response); if (!response.ok || body?.success !== true) throw new Error(typeof body?.error === 'string' ? body.error : t('deliveryFailed'))
      const result = body.data?.result
      if (result?.status !== 'SENT') throw new Error(typeof result?.failureMessage === 'string' ? result.failureMessage : t('deliveryFailed'))
      setStatus(t('deliverySent', { recipient: body.data.recipient })); setDeliveryReminderId(''); setDeliveryRecipient(''); setDeliveryReason(''); setDeliveryApproved(false); await load()
    } catch (actionError) { setError(actionError instanceof Error ? actionError.message : t('deliveryFailed')); await load() } finally { setBusy(false) }
  }

  if (loading) return <p>{t('loading')}</p>
  return <div className="container-fluid px-0">
    <header className="mb-4"><h1>{t('title')}</h1><p className="text-muted">{t('subtitle')}</p></header>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {status && <div className="alert alert-success" role="status">{status}</div>}
    <div className="row g-4">
      <section className="col-lg-5" aria-labelledby="new-partner-heading">
        <div className="card"><div className="card-body">
          <h2 id="new-partner-heading" className="h4">{t('newPartner')}</h2>
          <form onSubmit={submitPartner}>
            <div className="mb-3"><label className="form-label" htmlFor="partner-number">{t('partnerNumber')}</label><input required className="form-control" id="partner-number" value={partnerNumber} onChange={event => setPartnerNumber(event.target.value)} /></div>
            <div className="mb-3"><label className="form-label" htmlFor="partner-name">{t('name')}</label><input required className="form-control" id="partner-name" value={name} onChange={event => setName(event.target.value)} /></div>
            <div className="mb-3"><label className="form-label" htmlFor="partner-role">{t('role')}</label><select className="form-select" id="partner-role" value={role} onChange={event => setRole(event.target.value as PartnerSummary['role'])}><option value="CUSTOMER">{t('customer')}</option><option value="SUPPLIER">{t('supplier')}</option><option value="BOTH">{t('both')}</option></select></div>
            <div className="mb-3"><label className="form-label" htmlFor="payment-term">{t('paymentTerm')}</label><input required min="0" max="3650" step="1" type="number" className="form-control" id="payment-term" value={paymentTermDays} onChange={event => setPaymentTermDays(event.target.value)} /></div>
            <button disabled={busy} className="btn btn-primary" type="submit">{busy ? t('saving') : t('create')}</button>
          </form>
        </div></div>
      </section>
      <section className="col-lg-7" aria-labelledby="partners-heading">
        <h2 id="partners-heading" className="h4">{t('partners')}</h2>
        {partners.length ? <div className="table-responsive"><table className="table"><thead><tr><th>{t('partnerNumber')}</th><th>{t('name')}</th><th>{t('role')}</th><th>{t('paymentTerm')}</th></tr></thead><tbody>{partners.map(partner => <tr key={partner.id}><td>{partner.partnerNumber}</td><td>{partner.name}</td><td>{t(partner.role === 'CUSTOMER' ? 'customer' : partner.role === 'SUPPLIER' ? 'supplier' : 'both')}</td><td>{t('days', { count: partner.paymentTermDays })}</td></tr>)}</tbody></table></div> : <p>{t('noPartners')}</p>}
      </section>
    </div>
    <section className="mt-5" aria-labelledby="open-items-heading">
      <h2 id="open-items-heading" className="h4">{t('openItems')}</h2>
      {openItems.length ? <div className="table-responsive"><table className="table"><thead><tr><th>{t('documentNumber')}</th><th>{t('partner')}</th><th>{t('dueDate')}</th><th>{t('original')}</th><th>{t('remaining')}</th><th>{t('status')}</th><th>{t('actions')}</th></tr></thead><tbody>{openItems.map(item => { const eligible = item.status !== 'SETTLED' && item.originalAmountCents > item.allocatedAmountCents && item.commercialDocument.direction === 'RECEIVABLE' && item.commercialDocument.kind === 'INVOICE' && item.commercialDocument.dueDate.slice(0, 10) < new Date().toISOString().slice(0, 10); return <tr key={item.id}><td>{item.commercialDocument.documentNumber}</td><td>{item.commercialDocument.businessPartner.name}</td><td>{item.commercialDocument.dueDate.slice(0, 10)}</td><td>{formatMinorUnits(item.originalAmountCents, item.currency, locale)}</td><td>{formatMinorUnits(item.originalAmountCents - item.allocatedAmountCents, item.currency, locale)}</td><td>{item.status}</td><td>{eligible && <button disabled={busy} className="btn btn-sm btn-outline-primary" type="button" onClick={() => void issueReminder(item)}>{t('issueReminder')}</button>}</td></tr> })}</tbody></table></div> : <p>{t('noOpenItems')}</p>}
    </section>
    <section className="mt-5" aria-labelledby="reminders-heading">
      <h2 id="reminders-heading" className="h4">{t('reminders')}</h2><p className="text-muted">{t('manualScope')}</p>
      {reminders.length ? <div className="table-responsive"><table className="table"><thead><tr><th>{t('documentNumber')}</th><th>{t('level')}</th><th>{t('issuedOn')}</th><th>{t('remaining')}</th><th>{t('status')}</th><th>{t('deliveryHistory')}</th><th>{t('actions')}</th></tr></thead><tbody>{reminders.map(reminder => <tr key={reminder.id}><td>{reminder.invoiceNumber}</td><td>{reminder.level}</td><td>{reminder.issuedOn.slice(0, 10)}</td><td>{formatMinorUnits(reminder.remainingAmountCents, reminder.currency, locale)}</td><td>{reminder.cancellation ? t('cancelled') : t('active')}</td><td>{reminder.deliveryAttempts.length ? <ul className="list-unstyled mb-0">{reminder.deliveryAttempts.map(attempt => <li key={attempt.id}><span>{attempt.recipient}</span>: <strong>{attempt.result?.status === 'SENT' ? t('sent') : attempt.result?.status === 'FAILED' ? t('failed') : t('pending')}</strong>{attempt.result?.providerMessageId ? <small className="d-block text-muted">{t('providerMessage', { id: attempt.result.providerMessageId })}</small> : null}{attempt.result?.failureCode ? <small className="d-block text-danger">{attempt.result.failureCode}</small> : null}</li>)}</ul> : t('notSent')}</td><td><a className="btn btn-sm btn-outline-secondary me-2" href={`/api/commercial/reminders/${reminder.id}/print`} target="_blank" rel="noreferrer">{t('print')}</a><a className="btn btn-sm btn-outline-secondary me-2" href={`/api/commercial/reminders/${reminder.id}/print?download=1`}>{t('download')}</a>{!reminder.cancellation && <><button disabled={busy} className="btn btn-sm btn-outline-primary me-2" type="button" onClick={() => prepareDelivery(reminder.id)}>{t('prepareDelivery')}</button><button disabled={busy} className="btn btn-sm btn-outline-danger" type="button" onClick={() => void cancelReminder(reminder)}>{t('cancel')}</button></>}{deliveryReminderId === reminder.id && !reminder.cancellation ? <form className="mt-3 border rounded p-3" onSubmit={event => void sendReminder(event, reminder)}><p className="small">{t('explicitRecipientHelp')}</p><div className="mb-2"><label className="form-label" htmlFor={`delivery-recipient-${reminder.id}`}>{t('recipient')}</label><input className="form-control" id={`delivery-recipient-${reminder.id}`} type="email" required value={deliveryRecipient} onChange={event => setDeliveryRecipient(event.target.value)} /></div><div className="mb-2"><label className="form-label" htmlFor={`delivery-reason-${reminder.id}`}>{t('deliveryReason')}</label><input className="form-control" id={`delivery-reason-${reminder.id}`} required minLength={3} value={deliveryReason} onChange={event => setDeliveryReason(event.target.value)} /></div><div className="form-check mb-2"><input className="form-check-input" id={`delivery-approved-${reminder.id}`} type="checkbox" checked={deliveryApproved} onChange={event => setDeliveryApproved(event.target.checked)} /><label className="form-check-label" htmlFor={`delivery-approved-${reminder.id}`}>{t('approveDelivery')}</label></div><button className="btn btn-sm btn-primary" disabled={busy || !deliveryApproved} type="submit">{t('sendDelivery')}</button></form> : null}</td></tr>)}</tbody></table></div> : <p>{t('noReminders')}</p>}
    </section>
  </div>
}
