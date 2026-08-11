"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { PageHeading } from './PageHeading'
import { formatDisplayDateForLocale } from './dateFormatting'
import { useRegionalFormat } from './RegionalFormatProvider'
import { localizeErrorDates } from './errorFormatting'
import { LocalCurrency } from './LocalNumber'

type Workflow = { submissionId: string; kind: string; period: string; state: string; receipt?: string | null; correctsId?: string | null; updatedAt: string }
type Applicability = { kinds: string[]; deadline: string; professionalValidationRequired: boolean }
type PreparedDataset = { kind: string; period: string; fields: Record<string, number | string | boolean>; drilldown: Record<string, readonly string[]> }
type GatewayStatus = { mode: 'LOCAL_LIFECYCLE_EMULATOR' | 'CONFIGURED_EXTERNAL_GATEWAY' | 'NOT_CONFIGURED' }
type Assessment = { id: string; kind: string; period: string; authority: string; noticeId?: string | null; assessedAmountCents: number; differenceCents: number; needsReview: boolean; receivedAt: string }

/**
 * Keep persisted declaration kind codes out of the UI while retaining them for
 * API requests and workflow filtering.
 */
export function taxWorkflowKindLabel(kind: string, labels: Readonly<Record<string, string>>) {
  return labels[kind] ?? labels.unknown
}

/** Keep persisted workflow state codes out of the UI while retaining them for actions. */
export function taxWorkflowStateLabel(state: string, labels: Readonly<Record<string, string>>) {
  return labels[state] ?? labels.unknown
}

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
export function preparationSourceAfterValidation(kind: string, currentSource: string, dataset: PreparedDataset) { return ['USTVA', 'UST_ANNUAL'].includes(kind) ? JSON.stringify(dataset.fields, null, 2) : currentSource }
export function declarationPreparationRequest(kind: string, period: string, year: number, fields: string): [string, RequestInit?] {
  if (kind === 'USTVA') return [`/api/tax/vat-reconciliation?period=${encodeURIComponent(period)}`]
  if (kind === 'UST_ANNUAL') return [`/api/tax/vat-annual?year=${year}`]
  if ([2025, 2026].includes(year) && ['KST', 'GEWST'].includes(kind)) return ['/api/tax/annual/narrow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year }) }]
  return ['/api/tax/annual', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year, values: parseAnnualValues(fields) }) }]
}
export function annualAdjustmentRuleVersion(layer: string, year: number) {
  if (!['income-tax', 'trade-tax'].includes(layer) || ![2025, 2026].includes(year)) throw new Error('Annual adjustment rules are installed only for income/trade tax in 2025 and 2026.')
  return layer === 'income-tax' ? `KStG-${year}.1` : `GewStG-${year}.1`
}

export function TaxWorkspace({ year }: { year: number }) {
  const t = useTranslations('Tax')
  const { locale } = useRegionalFormat()
  const workflowKindLabels = {
    USTVA: t('workflowKinds.USTVA'),
    UST_ANNUAL: t('workflowKinds.UST_ANNUAL'),
    SONDERVORAUSZAHLUNG: t('workflowKinds.SONDERVORAUSZAHLUNG'),
    DAUERFRISTVERLAENGERUNG: t('workflowKinds.DAUERFRISTVERLAENGERUNG'),
    ZM: t('workflowKinds.ZM'),
    OSS: t('workflowKinds.OSS'),
    KST: t('workflowKinds.KST'),
    GEWST: t('workflowKinds.GEWST'),
    ZERLEGUNG: t('workflowKinds.ZERLEGUNG'),
    EST_BUSINESS: t('workflowKinds.EST_BUSINESS'),
    FESTSTELLUNG: t('workflowKinds.FESTSTELLUNG'),
    unknown: t('workflowKinds.unknown'),
  }
  const workflowStateLabels = {
    draft: t('workflowStates.draft'),
    validated: t('workflowStates.validated'),
    approved: t('workflowStates.approved'),
    submitting: t('workflowStates.submitting'),
    cancelling: t('workflowStates.cancelling'),
    uncertain: t('workflowStates.uncertain'),
    accepted: t('workflowStates.accepted'),
    rejected: t('workflowStates.rejected'),
    corrected: t('workflowStates.corrected'),
    cancelled: t('workflowStates.cancelled'),
    unknown: t('workflowStates.unknown'),
  }
  const [workflows, setWorkflows] = useState<Workflow[]>([])
  const [assessments, setAssessments] = useState<Assessment[]>([])
  const [applicability, setApplicability] = useState<Applicability | null>(null)
  const [applicabilityUnavailable, setApplicabilityUnavailable] = useState(false)
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus | null>(null)
  const [kind, setKind] = useState('USTVA')
  const [period, setPeriod] = useState(`${year}-01`)
  const [fields, setFields] = useState('{"KZ81":0,"ZAHLLAST":0}')
  const [confirmed, setConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [preparedDataset, setPreparedDataset] = useState<PreparedDataset | null>(null)
  const [annualPreview, setAnnualPreview] = useState<{ notice: string; ruleVersion: string; preview: Record<string, number> } | null>(null)
  const [adjustment, setAdjustment] = useState({ layer: 'income-tax', amountCents: 0, reason: '', evidenceIds: '' })
  const [assessment, setAssessment] = useState({ submissionId: '', assessedAmountCents: 0, receivedAt: '', noticeId: '', documentId: '' })
  const requestKeyRef = useRef<string | null>(null)
  const preparedDatasetRef = useRef<string | null>(null)
  const load = useCallback(async () => {
    const workflowResponse = await fetch('/api/tax/workflows')
    const workflowBody = await workflowResponse.json()
    const status = workspaceLoadStatus(workflowResponse.ok, false)
    if (!status.historyAvailable) throw new Error('load')
    setWorkflows(workflowBody.data)
    try { const response = await fetch('/api/tax/assessments'); const body = await response.json(); if (response.ok) setAssessments(body.data) } catch { /* Declaration work remains available when assessment history cannot load. */ }
    try {
      const annualResponse = await fetch(`/api/tax/annual?year=${year}`)
      const annualBody = await annualResponse.json()
      const annualAvailable = annualResponse.ok && Boolean(annualBody.data)
      setApplicability(annualAvailable ? annualBody.data : null); setApplicabilityUnavailable(!annualAvailable)
    } catch { setApplicability(null); setApplicabilityUnavailable(true) }
    try {
      const response = await fetch('/api/tax/gateway-status')
      const body = await response.json()
      setGatewayStatus(response.ok ? body.data : null)
    } catch { setGatewayStatus(null) }
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
        const preparationResponse = await fetch(...declarationPreparationRequest(kind, period, year, fields))
        const preparationBody = await preparationResponse.json()
        if (!preparationResponse.ok) throw new Error(Array.isArray(preparationBody.issues) ? preparationBody.issues.join(' ') : t('actionFailed'))
        dataset = ['USTVA', 'UST_ANNUAL'].includes(kind) ? preparationBody.data.dataset : preparationBody.data.datasets.find((candidate: PreparedDataset) => candidate.kind === kind)
        if (!dataset) throw new Error(t('actionFailed'))
        if ([2025, 2026].includes(year) && ['KST', 'GEWST'].includes(kind)) setAnnualPreview({ notice: preparationBody.data.notice, ruleVersion: preparationBody.data.ruleVersion, preview: preparationBody.data.preview })
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
  function selectKind(nextKind: string) { datasetChanged(() => { setKind(nextKind); setPeriod(nextKind === 'USTVA' ? `${year}-01` : String(year)); setFields(nextKind === 'USTVA' ? '{"KZ81":0,"ZAHLLAST":0}' : nextKind === 'UST_ANNUAL' ? '{}' : '[]'); setAnnualPreview(null) }) }
  async function saveAdjustment() {
    setBusy(true); setMessage('')
    try {
      const income = adjustment.layer === 'income-tax'
      const response = await fetch('/api/tax/annual/adjustments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year, adjustment: { id: crypto.randomUUID(), ruleVersion: annualAdjustmentRuleVersion(adjustment.layer, year), field: income ? 'STEUERLICHES_ERGEBNIS' : 'GEWERBEERTRAG', layer: adjustment.layer, amountCents: adjustment.amountCents, reason: adjustment.reason, sourceDocumentIds: adjustment.evidenceIds.split(',').map(value => value.trim()).filter(Boolean), legalBasis: income ? 'KStG §10' : 'GewStG §§8/9', treatment: adjustment.amountCents >= 0 ? 'add-back' : 'deduction' } }) })
      const body = await response.json(); if (!response.ok) throw new Error(Array.isArray(body.issues) ? body.issues.join(' ') : t('actionFailed'))
      datasetChanged(() => setAdjustment({ layer: 'income-tax', amountCents: 0, reason: '', evidenceIds: '' })); setAnnualPreview(null); setMessage(t('adjustmentSaved'))
    } catch (error) { setMessage(error instanceof Error ? error.message : t('actionFailed')) } finally { setBusy(false) }
  }
  async function saveAssessment() {
    const workflow = workflows.find(item => item.submissionId === assessment.submissionId)
    if (!workflow) return
    setBusy(true); setMessage('')
    try {
      const response = await fetch('/api/tax/assessments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), authority: 'FINANZAMT', noticeId: assessment.noticeId, documentId: assessment.documentId, kind: workflow.kind, period: workflow.period, assessedAmountCents: assessment.assessedAmountCents, receivedAt: assessment.receivedAt, declarationSubmissionId: workflow.submissionId }) })
      const body = await response.json(); if (!response.ok) throw new Error(Array.isArray(body.issues) ? body.issues.join(' ') : t('actionFailed'))
      setAssessment({ submissionId: '', assessedAmountCents: 0, receivedAt: '', noticeId: '', documentId: '' }); setMessage(t('assessmentSaved')); await load()
    } catch (error) { setMessage(error instanceof Error ? error.message : t('actionFailed')) } finally { setBusy(false) }
  }

  return <div className="workspace pb-4">
    <PageHeading title={t('title', { year })} subtitle={t('subtitle')} />
    {message && <p className="alert alert-danger" role="status">{localizeErrorDates(message, locale)}</p>}
    {gatewayStatus?.mode === 'LOCAL_LIFECYCLE_EMULATOR' && <p className="alert alert-warning" role="status">{t('gatewayLocal')}</p>}
    {gatewayStatus?.mode === 'NOT_CONFIGURED' && <p className="alert alert-danger" role="status">{t('gatewayNotConfigured')}</p>}
    {gatewayStatus?.mode === 'CONFIGURED_EXTERNAL_GATEWAY' && <p className="alert alert-info" role="status">{t('gatewayConfigured')}</p>}
    <div className="close-grid">
      <section className="card panel"><h2>{t('applicability')}</h2>{applicability ? <><p>{t('deadline', { date: formatDisplayDateForLocale(applicability.deadline, locale) })}</p><ul>{applicability.kinds.map(item => <li key={item}>{taxWorkflowKindLabel(item, workflowKindLabels)}</li>)}</ul><p>{t('professionalReview')}</p></> : applicabilityUnavailable ? <p className="alert alert-danger">{t('annualProfileRequired')}</p> : <p>{t('loading')}</p>}</section>
      <section className="card panel"><h2>{t('prepare')}</h2><label>{t('kind')}<select className="form-select" value={kind} onChange={event => selectKind(event.target.value)}><option value="USTVA">{taxWorkflowKindLabel('USTVA', workflowKindLabels)}</option>{applicability?.kinds.map(item => <option key={item} value={item}>{taxWorkflowKindLabel(item, workflowKindLabels)}</option>)}</select></label><label>{t('period')}<input className="form-control" value={period} readOnly={kind !== 'USTVA'} onChange={event => datasetChanged(() => setPeriod(event.target.value))} /></label>{[2025, 2026].includes(year) && ['KST', 'GEWST'].includes(kind) ? <>
        <p className="alert alert-warning">{t('annualPreviewNotice')}</p>
        {annualPreview && <div className="legal-note"><strong>{annualPreview.ruleVersion}</strong><p>{annualPreview.notice}</p><dl>{Object.entries(annualPreview.preview).filter((entry): entry is [string, number] => typeof entry[1] === 'number').map(([name, value]) => <div key={name}><dt>{name}</dt><dd><LocalCurrency cents={value} currency="EUR" /></dd></div>)}</dl></div>}
        <details><summary>{t('adjustmentSummary')}</summary><label>{t('adjustmentLayer')}<select className="form-select" value={adjustment.layer} onChange={event => setAdjustment({ ...adjustment, layer: event.target.value })}><option value="income-tax">KSt</option><option value="trade-tax">GewSt</option></select></label><label>{t('adjustmentAmount')}<input className="form-control" type="number" value={adjustment.amountCents} onChange={event => setAdjustment({ ...adjustment, amountCents: Number(event.target.value) })} /></label><label>{t('adjustmentReason')}<input className="form-control" value={adjustment.reason} onChange={event => setAdjustment({ ...adjustment, reason: event.target.value })} /></label><label>{t('adjustmentEvidence')}<input className="form-control" value={adjustment.evidenceIds} onChange={event => setAdjustment({ ...adjustment, evidenceIds: event.target.value })} /></label><button type="button" className="btn btn-outline-secondary mt-2" disabled={busy || !adjustment.reason.trim() || !adjustment.evidenceIds.trim()} onClick={() => void saveAdjustment()}>{t('saveAdjustment')}</button></details>
      </> : <label>{t('fields')}<textarea className="form-control" rows={5} value={fields} readOnly={Boolean(preparedDataset)} onChange={event => datasetChanged(() => setFields(event.target.value))} /></label>}<div className="form-check"><input id="tax-confirm" className="form-check-input" type="checkbox" disabled={!preparedDataset} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><label className="form-check-label" htmlFor="tax-confirm">{t('confirm')}</label></div><div className="d-flex gap-2 mt-3"><button className="btn btn-outline-secondary" disabled={busy} onClick={() => void action('validate')}>{t('validate')}</button><button className="btn btn-primary" disabled={busy || !confirmed || !preparedDataset} onClick={() => void action('submit')}>{t('submit')}</button></div></section>
    </div>
    <section className="card panel mt-4"><h2>{t('history')}</h2>{workflows.length ? <div className="table-responsive"><table className="table"><thead><tr><th>{t('kind')}</th><th>{t('period')}</th><th>{t('state')}</th><th>{t('receipt')}</th><th>{t('action')}</th></tr></thead><tbody>{workflows.map(item => <tr key={item.submissionId}><td>{taxWorkflowKindLabel(item.kind, workflowKindLabels)}</td><td>{item.period}</td><td>{taxWorkflowStateLabel(item.state, workflowStateLabels)}</td><td>{item.receipt ?? t('notAvailable')}</td><td>{['submitting', 'uncertain'].includes(item.state) ? <button className="btn btn-outline-secondary" disabled={busy} onClick={() => void recover(item)}>{t('recover')}</button> : t('notAvailable')}</td></tr>)}</tbody></table></div> : <p>{t('empty')}</p>}</section>
    {[2025, 2026].includes(year) && <section className="card panel mt-4"><h2>{t('assessmentTitle')}</h2><p>{t('assessmentDescription')}</p><div className="form-grid"><label>{t('acceptedDeclaration')}<select className="form-select" value={assessment.submissionId} onChange={event => setAssessment({ ...assessment, submissionId: event.target.value })}><option value="">{t('selectDeclaration')}</option>{workflows.filter(item => item.state === 'accepted' && ['KST', 'GEWST'].includes(item.kind)).map(item => <option value={item.submissionId} key={item.submissionId}>{taxWorkflowKindLabel(item.kind, workflowKindLabels)} · {item.period}</option>)}</select></label><label>{t('noticeId')}<input className="form-control" value={assessment.noticeId} onChange={event => setAssessment({ ...assessment, noticeId: event.target.value })} /></label><label>{t('assessedAmount')}<input className="form-control" type="number" value={assessment.assessedAmountCents} onChange={event => setAssessment({ ...assessment, assessedAmountCents: Number(event.target.value) })} /></label><label>{t('receivedOn')}<input className="form-control" type="date" value={assessment.receivedAt} onChange={event => setAssessment({ ...assessment, receivedAt: event.target.value })} /></label><label>{t('evidenceDocumentId')}<input className="form-control" value={assessment.documentId} onChange={event => setAssessment({ ...assessment, documentId: event.target.value })} /></label></div><button type="button" className="btn btn-primary" disabled={busy || !assessment.submissionId || !assessment.noticeId || !assessment.documentId || !assessment.receivedAt} onClick={() => void saveAssessment()}>{t('recordAssessment')}</button>{assessments.length > 0 && <table className="table mt-3"><thead><tr><th>{t('kind')}</th><th>{t('notice')}</th><th>{t('assessed')}</th><th>{t('difference')}</th><th>{t('status')}</th></tr></thead><tbody>{assessments.map(item => <tr key={item.id}><td>{taxWorkflowKindLabel(item.kind, workflowKindLabels)}</td><td>{item.noticeId ?? t('notAvailable')}</td><td><LocalCurrency cents={item.assessedAmountCents} currency="EUR" /></td><td><LocalCurrency cents={item.differenceCents} currency="EUR" /></td><td>{item.needsReview ? t('reviewRequired') : t('reconciled')}</td></tr>)}</tbody></table>}</section>}
  </div>
}
