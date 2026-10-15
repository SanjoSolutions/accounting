"use client"

import { useId, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'

export function EBalanceReportReview({ report, current, onApproved }: {
  report: { id: string; version: number; reportChecksum: string; status: string }
  current: boolean
  onApproved: () => void
}) {
  const t = useTranslations('EBalanceReportReview')
  const fieldId = useId()
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState('')
  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/compliance/e-bilanz', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'report.approve', reportId: report.id, reportChecksum: report.reportChecksum, reason, confirmed }) })
      const body = await response.json()
      if (!response.ok || body.success !== true) throw new Error(typeof body.error === 'string' ? body.error : t('failed'))
      setApproved(true); onApproved()
    } catch (error) { setError(error instanceof Error ? error.message : t('failed')) }
    finally { setBusy(false) }
  }
  return <div className="mt-3">
    <a className="btn btn-sm btn-outline-secondary" href={`/api/compliance/e-bilanz/${encodeURIComponent(report.id)}`}>{t('download', { version: report.version })}</a>
    <p className="small text-body-secondary mt-2">{t('boundary')}</p>
    {(approved || report.status === 'APPROVED') ? <p className="text-success mb-0" role="status">{t('approved')}</p> : current && ['PREPARED', 'EXPORTED'].includes(report.status) ?
      <form onSubmit={event => void approve(event)}>
        <label className="form-label" htmlFor={fieldId}>{t('reason')}</label>
        <textarea id={fieldId} className="form-control" required maxLength={2000} rows={2} disabled={busy} value={reason} onChange={event => setReason(event.target.value)} />
        <div className="form-check my-3"><input id={`${fieldId}-confirm`} className="form-check-input" type="checkbox" required disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />
          <label className="form-check-label" htmlFor={`${fieldId}-confirm`}>{t('confirm', { version: report.version })}</label></div>
        {error && <p className="alert alert-danger" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={busy || !confirmed || !reason.trim()}>{t(busy ? 'saving' : 'approve')}</button>
      </form> : null}
  </div>
}
