"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FiscalYearNavigation } from './FiscalYearNavigation'

type Workflow = { submissionId: string; kind: string; period: string; state: string; receipt?: string | null; correctsId?: string | null; updatedAt: string }
type Applicability = { kinds: string[]; deadline: string; professionalValidationRequired: boolean }
type PreparedDataset = { kind: string; period: string; fields: Record<string, number | string | boolean>; drilldown: Record<string, readonly string[]> }

export function parseDeclarationFields(value: string): Record<string, number | string | boolean> {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(item => !['number', 'string', 'boolean'].includes(typeof item) || typeof item === 'number' && !Number.isSafeInteger(item))) throw new Error('Declaration fields must be an object of strings, booleans and safe integer cents.')
  return parsed as Record<string, number | string | boolean>
}
export function parseAnnualValues(value: string): unknown[] { const parsed: unknown = JSON.parse(value); if (!Array.isArray(parsed)) throw new Error('Annual preparation values must be an array.'); return parsed }
export function submissionRequestKey(current: string | null, generate: () => string) { return current ?? generate() }
export function requestKeyAfterPreparation(current: string | null, previousDataset: string | null, nextDataset: string) { return previousDataset === nextDataset ? current : null }
export function shouldReplaySubmissionFailure(action: 'validate' | 'submit', requestKey: string | undefined, dataset: PreparedDataset | null) { return action === 'submit' && Boolean(requestKey && dataset) }
export function submissionSuccessMessage(submitted: string, refreshFailed: boolean, loadFailed: string) { return refreshFailed ? `${submitted} ${loadFailed}` : submitted }
export function submissionOutcomeMessage(state: unknown, messages: { accepted: string; pending: string; rejected: string; failed: string }) {
  if (state === 'accepted') return messages.accepted
  if (state === 'submitting' || state === 'uncertain') return messages.pending
  if (state === 'rejected') return messages.rejected
  return messages.failed
}
export function workspaceLoadStatus(workflowOk: boolean, annualOk: boolean) { return { historyAvailable: workflowOk, annualAvailable: annualOk } }
export function preparationSourceAfterValidation(kind: string, currentSource: string, dataset: PreparedDataset) { return kind === 'USTVA' ? JSON.stringify(dataset.fields, null, 2) : currentSource }

export function TaxWorkspace({ year }: { year: number }) {
  const t = useTranslations('Tax')
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [applicability, setApplicability] = useState<Applicability | null>(null)
  const [applicabilityUnavailable, setApplicabilityUnavailable] = useState(false)
  const [kind, setKind] = useState('USTVA')
  const [period, setPeriod] = useState(`${year}-01`)
  const [fields, setFields] = useState('{"KZ81":0,"ZAHLLAST":0}')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [preparedDataset, setPreparedDataset] = useState<PreparedDataset | null>(null)
  const requestKeyRef = useRef<string | null>(null)
  const preparedDatasetRef = useRef<string | null>(null)
  const load = useCallback(async () => {
    const workflowResponse = await fetch('/api/tax/workflows')
    const workflowBody = await workflowResponse.json()
    const status = workspaceLoadStatus(workflowResponse.ok, false)
    if (!status.historyAvailable) throw new Error('load')
    setWorkflows(workflowBody.data)
    try {
      const annualResponse = await fetch(`/api/tax/annual?year=${year}`)
      const annualBody = await annualResponse.json()
      const annualAvailable = annualResponse.ok && Boolean(annualBody.data)
      setApplicability(annualAvailable ? annualBody.data : null); setApplicabilityUnavailable(!annualAvailable)
    } catch { setApplicability(null); setApplicabilityUnavailable(true) }
  }, [year])
  useEffect(() => { setMessage(''); void load().catch(() => setMessage(t('loadFailed'))) }, [load, t])

  async function action(action: 'validate' | 'submit') {
    setBusy(true); setMessage('')
    let submittedRequest: { requestKey: string; dataset: PreparedDataset } | null = null
    try {
      const requestKey = action === 'submit' ? submissionRequestKey(requestKeyRef.current, () => crypto.randomUUID()) : undefined
      if (action === 'submit') requestKeyRef.current = requestKey!
      let dataset: PreparedDataset = preparedDataset ?? { kind, period, fields: {}, drilldown: {} }
      if (action === 'validate') {
        const preparationResponse = kind === 'USTVA'
          ? await fetch(`/api/tax/vat-reconciliation?period=${encodeURIComponent(period)}`)
          : await fetch('/api/tax/annual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year, values: parseAnnualValues(fields) }) })
        const preparationBody = await preparationResponse.json()
        if (!preparationResponse.ok) throw new Error(Array.isArray(preparationBody.issues) ? preparationBody.issues.join(' ') : t('actionFailed'))
        dataset = kind === 'USTVA' ? preparationBody.data.dataset : preparationBody.data.datasets.find((candidate: PreparedDataset) => candidate.kind === kind)
        if (!dataset) throw new Error(t('actionFailed'))
        const fingerprint = JSON.stringify(dataset)
        requestKeyRef.current = requestKeyAfterPreparation(requestKeyRef.current, preparedDatasetRef.current, fingerprint)
        preparedDatasetRef.current = fingerprint
        setPreparedDataset(dataset); setFields(preparationSourceAfterValidation(kind, fields, dataset)); setConfirmed(false)
      }
      if (action === 'submit') { if (!preparedDataset) throw new Error(t('actionFailed')); dataset = preparedDataset }
      if (shouldReplaySubmissionFailure(action, requestKey, action === 'submit' ? dataset : null)) submittedRequest = { requestKey: requestKey!, dataset }
      const response = await fetch('/api/tax/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, confirmed, requestKey, dataset }) })
      const body = await response.json()
      if (!response.ok) throw new Error(Array.isArray(body.issues) ? body.issues.join(' ') : t('actionFailed'))
      const resultMessage = action === 'validate' ? t('validated') : submissionOutcomeMessage(body.data?.state, { accepted: t('submitted'), pending: t('submissionPending'), rejected: t('submissionRejected'), failed: t('actionFailed') })
      setMessage(resultMessage)
      if (action === 'submit') {
        setConfirmed(false)
        try { await load() }
        catch { setMessage(submissionSuccessMessage(resultMessage, true, t('loadFailed'))) }
      }
    } catch (error) {
      const failureMessage = error instanceof Error ? error.message : t('actionFailed')
      if (submittedRequest) {
        try {
          const replayResponse = await fetch('/api/tax/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'submit', confirmed: true, ...submittedRequest }) })
          const replayBody = await replayResponse.json()
          if (replayResponse.ok) {
            const replayMessage = submissionOutcomeMessage(replayBody.data?.state, { accepted: t('submitted'), pending: t('submissionPending'), rejected: t('submissionRejected'), failed: t('actionFailed') })
            setConfirmed(false); setMessage(replayMessage)
            try { await load() } catch { setMessage(submissionSuccessMessage(replayMessage, true, t('loadFailed'))) }
            return
          }
        } catch { /* The preserved key can still be retried; history refresh below may expose recovery. */ }
        try { await load() } catch { /* Preserve the original transmission error when history is unavailable. */ }
      }
      setMessage(failureMessage)
    }
    finally { setBusy(false) }
  }
  async function recover(workflow: Workflow) {
    setBusy(true); setMessage('')
    try {
      const response = await fetch(`/api/tax/workflows/${workflow.submissionId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'recover', confirmed: true }) })
      const body = await response.json()
      if (!response.ok) throw new Error(Array.isArray(body.issues) ? body.issues.join(' ') : t('actionFailed'))
      const resultMessage = submissionOutcomeMessage(body.data?.state, { accepted: t('recovered'), pending: t('submissionPending'), rejected: t('submissionRejected'), failed: t('actionFailed') })
      setMessage(resultMessage)
      try { await load() } catch { setMessage(submissionSuccessMessage(resultMessage, true, t('loadFailed'))) }
    } catch (error) { setMessage(error instanceof Error ? error.message : t('actionFailed')) }
    finally { setBusy(false) }
  }
  function datasetChanged(update: () => void) { update(); requestKeyRef.current = null; preparedDatasetRef.current = null; setPreparedDataset(null); setConfirmed(false) }
  function selectKind(nextKind: string) { datasetChanged(() => { setKind(nextKind); setPeriod(nextKind === 'USTVA' ? `${year}-01` : String(year)); setFields(nextKind === 'USTVA' ? '{"KZ81":0,"ZAHLLAST":0}' : '[]') }) }

  return <div className="workspace pb-4">
    <FiscalYearNavigation area="tax" year={year} />
    <header className="page-heading"><div><span className="eyebrow">{t('eyebrow')}</span><h1>{t('title', { year })}</h1><p>{t('subtitle')}</p></div></header>
    {message && <p className="alert alert-danger" role="status">{message}</p>}
    <div className="close-grid">
      <section className="card panel"><h2>{t('applicability')}</h2>{applicability ? <><p>{t('deadline', { date: applicability.deadline })}</p><ul>{applicability.kinds.map(item => <li key={item}>{item}</li>)}</ul><p>{t('professionalReview')}</p></> : applicabilityUnavailable ? <p className="alert alert-danger">{t('annualProfileRequired')}</p> : <p>{t('loading')}</p>}</section>
      <section className="card panel"><h2>{t('prepare')}</h2><label>{t('kind')}<select className="form-select" value={kind} onChange={event => selectKind(event.target.value)}><option>USTVA</option>{applicability?.kinds.map(item => <option key={item}>{item}</option>)}</select></label><label>{t('period')}<input className="form-control" value={period} readOnly={kind !== 'USTVA'} onChange={event => datasetChanged(() => setPeriod(event.target.value))} /></label><label>{t('fields')}<textarea className="form-control" rows={5} value={fields} readOnly={Boolean(preparedDataset)} onChange={event => datasetChanged(() => setFields(event.target.value))} /></label><div className="form-check"><input id="tax-confirm" className="form-check-input" type="checkbox" disabled={!preparedDataset} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><label className="form-check-label" htmlFor="tax-confirm">{t('confirm')}</label></div><div className="d-flex gap-2 mt-3"><button className="btn btn-outline-secondary" disabled={busy} onClick={() => void action('validate')}>{t('validate')}</button><button className="btn btn-primary" disabled={busy || !confirmed || !preparedDataset} onClick={() => void action('submit')}>{t('submit')}</button></div></section>
    </div>
    <section className="card panel mt-4"><h2>{t('history')}</h2>{workflows.length ? <div className="table-responsive"><table className="table"><thead><tr><th>{t('kind')}</th><th>{t('period')}</th><th>{t('state')}</th><th>{t('receipt')}</th><th>{t('action')}</th></tr></thead><tbody>{workflows.map(item => <tr key={item.submissionId}><td>{item.kind}</td><td>{item.period}</td><td>{item.state}</td><td>{item.receipt ?? '—'}</td><td>{['submitting', 'uncertain'].includes(item.state) ? <button className="btn btn-outline-secondary" disabled={busy} onClick={() => void recover(item)}>{t('recover')}</button> : '—'}</td></tr>)}</tbody></table></div> : <p>{t('empty')}</p>}</section>
  </div>
}
