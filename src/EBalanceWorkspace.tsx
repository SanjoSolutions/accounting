"use client"

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FiscalYearNavigation } from './FiscalYearNavigation'

type LoadState = 'loading' | 'ready' | 'failed'
type EricReadiness = { validationReady: boolean; submissionReady: boolean; testMode: boolean; issues: string[] }
type EricHistoryItem = { id: string; kind: string; status: string; idempotencyKey: string; ericMessage: string | null; createdAt: string }
type LifecycleReport = { id: string; fiscalYearId: string; closeGenerationId: string | null; version: number; status: string; sourceStatus: 'CURRENT' | 'STALE'; taxonomyVersion: string; reportChecksum: string; createdAt: string }
type LifecycleOverview = { taxonomies: Array<{ version: string; validForFiscalPeriodsStartingFrom: string; validForFiscalPeriodsStartingThrough: string }>; reports: LifecycleReport[]; reconciliations: Array<{ id: string; fiscalYearId: string; kind: string }>; closeEvidence: { fiscalYearId: string; currentCloseGenerationId: string | null; sourceStatus: 'CURRENT' | 'STALE' | 'NOT_LOCKED'; issue: string | null } | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function readJsonResponse(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const data: unknown = await response.json()
    return isRecord(data) ? data : null
  } catch {
    return null
  }
}

export function responseIssues(data: Record<string, unknown> | null, fallback: string): string[] {
  if (!Array.isArray(data?.issues)) return [fallback]
  const issues = data.issues.filter((issue): issue is string => typeof issue === 'string' && issue.length > 0)
  return issues.length > 0 ? issues : [fallback]
}

export function parseEricStatus(data: Record<string, unknown> | null): { readiness: EricReadiness; fiscalYearStatus: string; history: EricHistoryItem[] } | null {
  if (!data || !isRecord(data.readiness) || typeof data.fiscalYearStatus !== 'string' || !Array.isArray(data.history)) return null
  const readiness = data.readiness
  if (typeof readiness.validationReady !== 'boolean' || typeof readiness.submissionReady !== 'boolean' || typeof readiness.testMode !== 'boolean'
    || !Array.isArray(readiness.issues) || !readiness.issues.every(issue => typeof issue === 'string')) return null
  const history = data.history
  if (!history.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.kind === 'string' && typeof item.status === 'string'
    && typeof item.idempotencyKey === 'string' && (typeof item.ericMessage === 'string' || item.ericMessage === null) && typeof item.createdAt === 'string')) return null
  return { readiness: readiness as EricReadiness, fiscalYearStatus: data.fiscalYearStatus, history: history as EricHistoryItem[] }
}

export function parseLifecycleOverview(data: Record<string, unknown> | null): LifecycleOverview | null {
  const value = isRecord(data?.data) ? data.data : data
  if (!value || !Array.isArray(value.taxonomies) || !Array.isArray(value.reports) || !Array.isArray(value.reconciliations)) return null
  if (!value.taxonomies.every(item => isRecord(item) && typeof item.version === 'string' && typeof item.validForFiscalPeriodsStartingFrom === 'string' && typeof item.validForFiscalPeriodsStartingThrough === 'string')) return null
  if (!value.reports.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.fiscalYearId === 'string' && (typeof item.closeGenerationId === 'string' || item.closeGenerationId === null) && typeof item.version === 'number' && typeof item.status === 'string' && ['CURRENT', 'STALE'].includes(String(item.sourceStatus)) && typeof item.taxonomyVersion === 'string' && typeof item.reportChecksum === 'string' && typeof item.createdAt === 'string')) return null
  if (!value.reconciliations.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.fiscalYearId === 'string' && typeof item.kind === 'string')) return null
  if (value.closeEvidence !== null && (!isRecord(value.closeEvidence) || typeof value.closeEvidence.fiscalYearId !== 'string' || !['CURRENT', 'STALE', 'NOT_LOCKED'].includes(String(value.closeEvidence.sourceStatus)) || !(typeof value.closeEvidence.currentCloseGenerationId === 'string' || value.closeEvidence.currentCloseGenerationId === null) || !(typeof value.closeEvidence.issue === 'string' || value.closeEvidence.issue === null))) return null
  return value as LifecycleOverview
}

export function lifecycleOverviewPath(fiscalYearId: string) {
  if (!fiscalYearId.trim()) throw new Error('Fiscal year ID is required')
  return `/api/compliance/e-bilanz?fiscalYearId=${encodeURIComponent(fiscalYearId)}`
}

export function scopeLifecycleOverview(overview: LifecycleOverview, fiscalYearId: string): LifecycleOverview {
  return { ...overview, reports: overview.reports.filter(report => report.fiscalYearId === fiscalYearId), reconciliations: overview.reconciliations.filter(record => record.fiscalYearId === fiscalYearId), closeEvidence: overview.closeEvidence?.fiscalYearId === fiscalYearId ? overview.closeEvidence : null }
}

export async function resolveJsonRequest(request: () => Promise<Response>, fallback: string) {
  try {
    const response = await request()
    const data = await readJsonResponse(response)
    return { response, data, issues: response.ok && data ? [] : responseIssues(data, fallback) }
  } catch {
    return { response: null, data: null, issues: [fallback] }
  }
}

export function EBalanceWorkspace({ year }: { year: number }) {
  const t = useTranslations('Workspaces')
  const [companyName, setCompanyName] = useState('')
  const [street, setStreet] = useState('')
  const [postalCode, setPostalCode] = useState('')
  const [city, setCity] = useState('')
  const [taxNumber, setTaxNumber] = useState('')
  const [legalForm, setLegalForm] = useState('GMBH')
  const [masterDataSource, setMasterDataSource] = useState('')
  const [masterDataLoadState, setMasterDataLoadState] = useState<LoadState>('loading')
  const [ledgerIssues, setLedgerIssues] = useState<string[]>([])
  const [requestIssues, setRequestIssues] = useState<string[]>([])
  const [ledgerLoadState, setLedgerLoadState] = useState<LoadState>('loading')
  const [coverage, setCoverage] = useState({ mapped: 0, total: 0 })
  const [eric, setEric] = useState<EricReadiness>({ validationReady: false, submissionReady: false, testMode: false, issues: [] })
  const [fiscalYearStatus, setFiscalYearStatus] = useState('OPEN')
  const [history, setHistory] = useState<EricHistoryItem[]>([])
  const [pin, setPin] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [ericBusy, setEricBusy] = useState(false)
  const [submissionUncertain, setSubmissionUncertain] = useState(false)
  const [exportBusy, setExportBusy] = useState(false)
  const [ericMessage, setEricMessage] = useState('')
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID())
  const [lifecycle, setLifecycle] = useState<LifecycleOverview>({ taxonomies: [], reports: [], reconciliations: [], closeEvidence: null })
  const [selectedFiscalYearId, setSelectedFiscalYearId] = useState<string | null>(null)
  const [sourceEdited, setSourceEdited] = useState(false)
  const yearRef = useRef(year)
  useEffect(() => {
    yearRef.current = year
    const submissionContext = resetSubmissionForYear()
    setIdempotencyKey(submissionContext.idempotencyKey); setSubmissionUncertain(submissionContext.uncertain); setConfirmed(submissionContext.confirmed)
    setEricMessage(''); setRequestIssues([]); setPin(''); setEricBusy(false); setExportBusy(false)
    setSelectedFiscalYearId(null); setLifecycle({ taxonomies: [], reports: [], reconciliations: [], closeEvidence: null }); setMasterDataLoadState('loading'); setMasterDataSource(''); setSourceEdited(false)
  }, [year])
  useEffect(() => {
    const controller = new AbortController(); const requestedYear = year
    void resolveJsonRequest(() => fetch(`/api/fiscal-years/${year}/e-balance`, { signal: controller.signal }), t('eBalanceLoadFailed')).then(result => {
      if (controller.signal.aborted || !isCurrentEBalanceYear(requestedYear, yearRef.current)) return
      const value = isRecord(result.data?.data) ? result.data.data : result.data
      const masterData = isRecord(value?.masterData) ? value.masterData : null
      if (!result.response?.ok || !masterData || !['companyName', 'street', 'postalCode', 'city', 'taxNumber', 'legalForm'].every(key => typeof masterData[key] === 'string')) { setRequestIssues(result.issues); setMasterDataLoadState('failed'); return }
      setCompanyName(String(masterData.companyName)); setStreet(String(masterData.street)); setPostalCode(String(masterData.postalCode)); setCity(String(masterData.city)); setTaxNumber(String(masterData.taxNumber)); setLegalForm(String(masterData.legalForm)); setMasterDataSource(typeof value?.source === 'string' ? value.source : 'MANUAL_INPUT'); setMasterDataLoadState('ready')
    })
    return () => controller.abort()
  }, [year, t])
  useEffect(() => {
    if (!selectedFiscalYearId) return
    const controller = new AbortController()
    const requestedYear = year
    void resolveJsonRequest(() => fetch(lifecycleOverviewPath(selectedFiscalYearId), { signal: controller.signal }), t('eBalanceLoadFailed')).then(result => {
      if (controller.signal.aborted || !isCurrentEBalanceYear(requestedYear, yearRef.current) || !result.response?.ok) return
      const parsed = parseLifecycleOverview(result.data); if (parsed) setLifecycle(scopeLifecycleOverview(parsed, selectedFiscalYearId))
    })
    return () => controller.abort()
  }, [selectedFiscalYearId, year, t])
  useEffect(() => {
    const controller = new AbortController()
    setLedgerLoadState('loading'); setLedgerIssues([]); setRequestIssues([]); setCoverage({ mapped: 0, total: 0 })
    void (async () => {
      try {
        const result = await resolveJsonRequest(() => fetch(`/api/booking-records?year=${year}`, { signal: controller.signal }), t('eBalanceLoadFailed'))
        if (controller.signal.aborted) return
        const { response, data } = result
        const statements = isRecord(data?.statements) ? data.statements : null
        if (!response?.ok || !statements || !Array.isArray(statements.balances)) {
          setLedgerIssues(result.issues.length > 0 ? result.issues : [t('eBalanceLoadFailed')]); setLedgerLoadState('failed'); return
        }
        const valued = statements.balances.filter((item): item is Record<string, unknown> => isRecord(item) && typeof item.balanceCents === 'number' && item.balanceCents !== 0)
        setCoverage({ mapped: valued.filter(item => typeof item.eBilanzPosition === 'string' && item.eBilanzPosition.length > 0).length, total: valued.length })
        const fiscalYear = isRecord(data?.fiscalYear) ? data.fiscalYear : null
        const status = fiscalYear && typeof fiscalYear.status === 'string' ? fiscalYear.status : 'OPEN'
        if (typeof fiscalYear?.id === 'string' && fiscalYear.id.length > 0) setSelectedFiscalYearId(fiscalYear.id)
        const issues = data && Array.isArray(data.closingIssues) ? data.closingIssues.filter((issue): issue is string => typeof issue === 'string') : []
        setLedgerIssues(filterEBalanceLedgerIssues(status, issues))
        setLedgerLoadState('ready')
      } catch {
        if (!controller.signal.aborted) { setLedgerIssues([t('eBalanceLoadFailed')]); setLedgerLoadState('failed') }
      }
    })()
    return () => controller.abort()
  }, [year, t])
  useEffect(() => {
    const controller = new AbortController()
    setEric({ validationReady: false, submissionReady: false, testMode: false, issues: [] }); setFiscalYearStatus('OPEN'); setHistory([])
    void refreshEricStatus(controller.signal)
    return () => controller.abort()
  }, [year])

  async function refreshEricStatus(signal?: AbortSignal, requestedYear = year) {
    const result = await resolveJsonRequest(() => fetch(`/api/fiscal-years/${year}/e-balance/eric-status?idempotencyKey=${encodeURIComponent(idempotencyKey)}`, { signal }), t('ericFailed'))
    if (signal?.aborted || !isCurrentEBalanceYear(requestedYear, yearRef.current)) return
    const { response, data } = result
    const parsed = parseEricStatus(data)
    if (!response?.ok || !parsed) {
      setRequestIssues(result.issues.length > 0 ? result.issues : [t('ericFailed')])
      return
    }
    const nextHistory = parsed.history
    setEric(parsed.readiness); setFiscalYearStatus(parsed.fiscalYearStatus); setHistory(nextHistory)
    const matchingAttempt = nextHistory.find(item => item.kind === 'SUBMISSION' && item.idempotencyKey === idempotencyKey)
    if (matchingAttempt && ['REJECTED', 'FAILED'].includes(matchingAttempt.status)) setIdempotencyKey(crypto.randomUUID())
    setSubmissionUncertain(current => current && !matchingAttempt)
  }

  async function download(event: React.FormEvent) {
    event.preventDefault()
    if (!canRunEBalanceAction(combinedLoadState(ledgerLoadState, masterDataLoadState), ledgerIssues, exportBusy)) return
    const requestedYear = year
    setRequestIssues([]); setExportBusy(true)
    try {
      const response = await fetch(`/api/fiscal-years/${year}/e-balance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyName, street, postalCode, city, taxNumber, legalForm }) })
      if (!isCurrentEBalanceYear(requestedYear, yearRef.current)) return
      if (!response.ok) {
        const body = await readJsonResponse(response)
        if (isCurrentEBalanceYear(requestedYear, yearRef.current)) setRequestIssues(responseIssues(body, t('exportFailed')))
        return
      }
      const blob = await response.blob()
      if (!isCurrentEBalanceYear(requestedYear, yearRef.current)) return
      const url = URL.createObjectURL(blob)
      try { const link = document.createElement('a'); link.href = url; link.download = `e-bilanz-${year}-pruefpaket.zip`; link.click() } finally { URL.revokeObjectURL(url) }
      if (selectedFiscalYearId) {
        const overviewResult = await resolveJsonRequest(() => fetch(lifecycleOverviewPath(selectedFiscalYearId)), t('eBalanceLoadFailed'))
        const parsed = overviewResult.response?.ok ? parseLifecycleOverview(overviewResult.data) : null
        if (parsed) setLifecycle(scopeLifecycleOverview(parsed, selectedFiscalYearId))
      }
      setSourceEdited(false)
    } catch {
      if (isCurrentEBalanceYear(requestedYear, yearRef.current)) setRequestIssues([t('exportFailed')])
    } finally { if (isCurrentEBalanceYear(requestedYear, yearRef.current)) setExportBusy(false) }
  }
  async function processWithEric(send: boolean) {
    if (!canRunEBalanceAction(combinedLoadState(ledgerLoadState, masterDataLoadState), ledgerIssues, ericBusy)) return
    const requestedYear = year
    setEricBusy(true); setEricMessage(''); setRequestIssues([])
    try {
      const result = await resolveJsonRequest(() => fetch(`/api/fiscal-years/${year}/e-balance/${send ? 'submit' : 'validate'}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ companyName, street, postalCode, city, taxNumber, legalForm, ...(send ? { pin, confirmed, idempotencyKey } : {}) }),
      }), t('ericFailed'))
      if (!isCurrentEBalanceYear(requestedYear, yearRef.current)) return
      if (!result.response?.ok || !result.data) {
        setRequestIssues(result.issues)
        if (send) {
          setConfirmed(false)
          if (isDefinitiveUnsentResult(result.response?.status, result.data?.sent)) setIdempotencyKey(crypto.randomUUID())
          else setSubmissionUncertain(true)
        }
        await refreshEricStatus(undefined, requestedYear)
        return
      }
      setEricMessage(send ? t('ericSubmitted') : t('ericValid'))
      if (send) { setPin(''); setConfirmed(false) }
      await refreshEricStatus(undefined, requestedYear)
    } catch {
      if (isCurrentEBalanceYear(requestedYear, yearRef.current)) setRequestIssues([t('ericFailed')])
    } finally { if (isCurrentEBalanceYear(requestedYear, yearRef.current)) setEricBusy(false) }
  }
  const percent = coverage.total ? Math.round(coverage.mapped / coverage.total * 100) : 100
  const lifecycleView = reportLifecycleView(lifecycle, sourceEdited)
  return <div className="workspace pb-4">
    <FiscalYearNavigation area="e-bilanz" year={year} />
    <header className="page-heading"><div><span className="eyebrow">{t('taxSubmission')}</span><h1>{t('eBalanceYear', { year })}</h1><p>{t('eBalanceSubtitle')}</p></div><span className="taxonomy">{t('taxonomy')} <strong>{lifecycle.taxonomies.find(item => item.validForFiscalPeriodsStartingFrom <= `${year}-12-31` && `${year}-01-01` <= item.validForFiscalPeriodsStartingThrough)?.version ?? '—'}</strong></span></header>
    <div className="ebalance-grid">
      <form className="card panel" onSubmit={download}><div className="panel-title"><div><span className="step">{t('gcdMasterData')}</span><h2>{t('prepareReport')}</h2></div></div>
        <fieldset className="row g-3" disabled={isEBalanceMasterDataLocked(ericBusy, exportBusy)}>
        <div className="col-12"><label className="form-label" htmlFor="e-balance-company-name">{t('companyName')}</label><input id="e-balance-company-name" className="form-control" required readOnly={masterDataSource !== 'MANUAL_INPUT'} value={companyName} onChange={event => { setCompanyName(event.target.value); prepareChangedReportSource() }} /></div>
        <div className="col-12"><label className="form-label" htmlFor="e-balance-street">{t('companyStreet')}</label><input id="e-balance-street" className="form-control" required readOnly={masterDataSource !== 'MANUAL_INPUT'} autoComplete="street-address" value={street} onChange={event => { setStreet(event.target.value); prepareChangedReportSource() }} /></div>
        <div className="col-sm-4"><label className="form-label" htmlFor="e-balance-postal-code">{t('companyPostalCode')}</label><input id="e-balance-postal-code" className="form-control" required readOnly={masterDataSource !== 'MANUAL_INPUT'} autoComplete="postal-code" value={postalCode} onChange={event => { setPostalCode(event.target.value); prepareChangedReportSource() }} /></div>
        <div className="col-sm-8"><label className="form-label" htmlFor="e-balance-city">{t('companyCity')}</label><input id="e-balance-city" className="form-control" required readOnly={masterDataSource !== 'MANUAL_INPUT'} autoComplete="address-level2" value={city} onChange={event => { setCity(event.target.value); prepareChangedReportSource() }} /></div>
        <div className="col-sm-6"><label className="form-label" htmlFor="e-balance-tax-number">{t('taxNumber')}</label><input id="e-balance-tax-number" className="form-control" required readOnly={masterDataSource !== 'MANUAL_INPUT'} inputMode="numeric" value={taxNumber} onChange={event => { setTaxNumber(event.target.value); prepareChangedReportSource() }} placeholder="1234567890123" /></div>
        <div className="col-sm-6"><label className="form-label" htmlFor="e-balance-legal-form">{t('legalForm')}</label><select id="e-balance-legal-form" className="form-select" required disabled={masterDataSource !== 'MANUAL_INPUT'} value={legalForm} onChange={event => { setLegalForm(event.target.value); prepareChangedReportSource() }}>
          <option value="EUN">{t('legalFormEU')}</option><option value="GMBH">GmbH</option><option value="UG">UG (haftungsbeschränkt)</option><option value="AG">AG</option>
        </select></div>
        {masterDataSource && <div className="col-12"><p className="legal-note mb-0" role="status">{masterDataSource === 'MANUAL_INPUT' ? t('eBalanceManualMasterData') : t('eBalanceAuthoritativeMasterData')}</p></div>}
        {lifecycleView.regenerationRequired && <div className="col-12"><div className="alert alert-danger mb-0" role="alert"><strong>{t('eBalanceRegenerationRequired')}</strong><p>{t('eBalanceRegenerationReason')}</p>{lifecycle.closeEvidence?.sourceStatus === 'STALE' && <p><a href="/compliance">{t('reviewAuthoritativeSource')}</a> · <a href={`/annual-close/${year}`}>{t('rerunAndRelockClose')}</a></p>}</div></div>}
        {ledgerLoadState === 'loading' && <div className="col-12"><p className="mb-0" role="status">{t('eBalanceLoading')}</p></div>}
        {[...ledgerIssues, ...requestIssues].length > 0 && <div className="col-12"><div className="alert alert-danger mb-0" role="alert"><strong>{t('exportBlocked')}</strong><ul>{[...new Set([...ledgerIssues, ...requestIssues])].map(issue => <li key={issue}>{issue}</li>)}</ul></div></div>}
        <div className="col-12"><button className="btn btn-primary w-100" disabled={!canRegenerateAgainstCloseEvidence(lifecycle.closeEvidence) || !canRunEBalanceAction(combinedLoadState(ledgerLoadState, masterDataLoadState), ledgerIssues, exportBusy)}>{exportBusy ? t('eBalanceExporting') : lifecycleView.regenerationRequired ? t('regenerateAndRevalidateXbrlPackage') : t('createXbrlPackage')}</button></div>
        </fieldset>
      </form>
      <section className="card panel"><div className="panel-title"><div><span className="step">{t('accountDetails')}</span><h2>{t('mappingCoverage')}</h2></div><strong className="coverage-number">{percent} %</strong></div>
        <div className="progress-track"><span style={{ width: `${percent}%` }} /></div><p>{t('mappingCount', { mapped: coverage.mapped, total: coverage.total })}</p>
        <hr /><div className="panel-title"><div><span className="step">ERiC 44 · Bilanz 6.9</span><h2>{t('officialValidation')}</h2></div><span className="taxonomy">{eric.testMode ? t('testMode') : t('productionMode')}</span></div>
        {eric.issues.length > 0 && <div className="legal-note"><strong>{t('ericSetupRequired')}</strong><ul>{eric.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
        {ericMessage && <p className="alert alert-success" role="status">{ericMessage}</p>}
        <button type="button" className="btn btn-outline-secondary w-100 mt-3" disabled={lifecycleView.regenerationRequired || !eric.validationReady || !canRunEBalanceAction(combinedLoadState(ledgerLoadState, masterDataLoadState), ledgerIssues, ericBusy)} onClick={() => void processWithEric(false)}>{ericBusy ? t('ericBusy') : t('validateWithEric')}</button>
        <div className="mt-3 mb-3"><label className="form-label" htmlFor="e-balance-certificate-pin">{t('certificatePin')}</label><input id="e-balance-certificate-pin" className="form-control" type="password" autoComplete="off" value={pin} onChange={event => { setPin(event.target.value); prepareCorrectedAttempt() }} /></div>
        <div className="form-check mb-3"><input id="e-balance-submission-confirmation" className="form-check-input" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><label className="form-check-label" htmlFor="e-balance-submission-confirmation">{t('submissionConfirmation')}</label></div>
        <button type="button" className="btn btn-primary w-100" disabled={!canSubmitEBalance(eric.submissionReady, fiscalYearStatus, confirmed, pin, history.some(item => item.kind === 'SUBMISSION' && isActiveSubmissionStatus(item.status)), submissionUncertain) || !canRunEBalanceAction(combinedLoadState(ledgerLoadState, masterDataLoadState), ledgerIssues, ericBusy)} onClick={() => void processWithEric(true)}>{t('submitBinding')}</button>
        {history.length > 0 && <div><h3>{t('submissionHistory')}</h3><ul>{history.map(item => <li key={item.id}><strong>{item.kind === 'SUBMISSION' ? t('submission') : t('validation')}</strong> · {item.status} · {new Date(item.createdAt).toLocaleString()} {item.ericMessage ? `— ${item.ericMessage}` : ''}</li>)}</ul></div>}
        <div className="legal-note"><strong>{t('productBoundary')}</strong><p>{t('ericBoundary')}</p></div>
      </section>
      <section className="card panel"><div className="panel-title"><div><span className="step">{t('lifecycleEvidence')}</span><h2>{t('immutableReportVersions')}</h2></div><span className="badge text-bg-secondary">{lifecycle.reports.length}</span></div>
        {lifecycle.closeEvidence && <p className={`alert ${lifecycle.closeEvidence.sourceStatus === 'CURRENT' ? 'alert-success' : 'alert-danger'}`} role="status"><strong>{t('closeEvidence')}</strong> · {lifecycle.closeEvidence.sourceStatus}{lifecycle.closeEvidence.issue ? ` · ${lifecycle.closeEvidence.issue}` : ''}</p>}
        {lifecycle.reports.length ? <ul className="list-group list-group-flush">{lifecycle.reports.map(report => <li className="list-group-item" key={report.id}><strong>v{report.version} · {report.status} · {sourceEdited ? 'STALE' : report.sourceStatus}</strong><br/>{t('closeGeneration')} <code>{report.closeGenerationId ?? '—'}</code><br/>{t('taxonomy')} {report.taxonomyVersion}<br/><code>{report.reportChecksum}</code></li>)}</ul> : <p>{t('noLifecycleReports')}</p>}
        <p className="small text-body-secondary">{t('reconciliationEvidenceCount', { count: lifecycle.reconciliations.length })}</p>
      </section>
    </div>
  </div>

  function prepareCorrectedAttempt() {
    const invalidated = invalidateReportApproval()
    setRequestIssues([])
    setConfirmed(invalidated.confirmed)
    setEricMessage(invalidated.message)
  }
  function prepareChangedReportSource() {
    prepareCorrectedAttempt()
    setSourceEdited(true)
  }
}

export function reportLifecycleView(lifecycle: LifecycleOverview, sourceEdited: boolean) {
  const hasCurrentReport = lifecycle.reports.some(report => report.sourceStatus === 'CURRENT')
  return {
    regenerationRequired: sourceEdited || lifecycle.closeEvidence?.sourceStatus === 'STALE' || lifecycle.reports.length > 0 && !hasCurrentReport,
    hasCurrentReport: hasCurrentReport && !sourceEdited,
  }
}

export function canRegenerateAgainstCloseEvidence(evidence: LifecycleOverview['closeEvidence']) {
  return evidence === null || evidence.sourceStatus === 'CURRENT'
}

export function canSubmitEBalance(submissionReady: boolean, fiscalYearStatus: string, confirmed: boolean, pin: string, activeSubmission = false, submissionUncertain = false) {
  return submissionReady && fiscalYearStatus === 'CLOSED' && confirmed && pin.length > 0 && !activeSubmission && !submissionUncertain
}

export function canRunEBalanceAction(loadState: LoadState, issues: string[], busy = false) {
  return loadState === 'ready' && issues.length === 0 && !busy
}
export function combinedLoadState(...states: LoadState[]): LoadState { return states.includes('failed') ? 'failed' : states.every(state => state === 'ready') ? 'ready' : 'loading' }

export function isActiveSubmissionStatus(status: string) { return ['PENDING', 'UNKNOWN', 'ACCEPTED'].includes(status) }
export function filterEBalanceLedgerIssues(fiscalYearStatus: string, issues: string[]) {
  return fiscalYearStatus === 'CLOSED' ? issues.filter(issue => !issue.includes('bereits abgeschlossene Folgejahr')) : issues
}
export function invalidateReportApproval() { return { confirmed: false, message: '' } as const }
export function isDefinitiveUnsentResult(status: number | undefined, sent: unknown) { return status === 422 && sent === false }
export function resetSubmissionForYear(createKey: () => string = () => crypto.randomUUID()) {
  return { idempotencyKey: createKey(), uncertain: false, confirmed: false } as const
}
export function isCurrentEBalanceYear(requestedYear: number, currentYear: number) { return requestedYear === currentYear }
export function isEBalanceMasterDataLocked(ericBusy: boolean, exportBusy: boolean) { return ericBusy || exportBusy }
