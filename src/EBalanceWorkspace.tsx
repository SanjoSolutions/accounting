"use client"

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FiscalYearNavigation } from './FiscalYearNavigation'

type LoadState = 'loading' | 'ready' | 'failed'
type EricReadiness = { validationReady: boolean; submissionReady: boolean; testMode: boolean; issues: string[] }
type EricHistoryItem = { id: string; kind: string; status: string; idempotencyKey: string; ericMessage: string | null; createdAt: string }

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
  const yearRef = useRef(year)
  useEffect(() => {
    yearRef.current = year
    const submissionContext = resetSubmissionForYear()
    setIdempotencyKey(submissionContext.idempotencyKey); setSubmissionUncertain(submissionContext.uncertain); setConfirmed(submissionContext.confirmed)
    setEricMessage(''); setRequestIssues([]); setPin(''); setEricBusy(false); setExportBusy(false)
  }, [year])
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
        const status = isRecord(data?.fiscalYear) && typeof data.fiscalYear.status === 'string' ? data.fiscalYear.status : 'OPEN'
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
    if (!canRunEBalanceAction(ledgerLoadState, ledgerIssues, exportBusy)) return
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
    } catch {
      if (isCurrentEBalanceYear(requestedYear, yearRef.current)) setRequestIssues([t('exportFailed')])
    } finally { if (isCurrentEBalanceYear(requestedYear, yearRef.current)) setExportBusy(false) }
  }
  async function processWithEric(send: boolean) {
    if (!canRunEBalanceAction(ledgerLoadState, ledgerIssues, ericBusy)) return
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
  return <div className="workspace py-4">
    <FiscalYearNavigation area="e-bilanz" year={year} />
    <header className="page-heading"><div><span className="eyebrow">{t('taxSubmission')}</span><h1>{t('eBalanceYear', { year })}</h1><p>{t('eBalanceSubtitle')}</p></div><span className="taxonomy">{t('taxonomy')} <strong>6.9</strong></span></header>
    <div className="ebalance-grid">
      <form className="panel" onSubmit={download}><div className="panel-title"><div><span className="step">{t('gcdMasterData')}</span><h2>{t('prepareReport')}</h2></div></div>
        <fieldset className="ebalance-master-data" disabled={isEBalanceMasterDataLocked(ericBusy, exportBusy)}>
        <label>{t('companyName')}<input required value={companyName} onChange={event => { setCompanyName(event.target.value); prepareCorrectedAttempt() }} /></label>
        <label>{t('companyStreet')}<input required autoComplete="street-address" value={street} onChange={event => { setStreet(event.target.value); prepareCorrectedAttempt() }} /></label>
        <label>{t('companyPostalCode')}<input required autoComplete="postal-code" value={postalCode} onChange={event => { setPostalCode(event.target.value); prepareCorrectedAttempt() }} /></label>
        <label>{t('companyCity')}<input required autoComplete="address-level2" value={city} onChange={event => { setCity(event.target.value); prepareCorrectedAttempt() }} /></label>
        <label>{t('taxNumber')}<input required inputMode="numeric" value={taxNumber} onChange={event => { setTaxNumber(event.target.value); prepareCorrectedAttempt() }} placeholder="1234567890123" /></label>
        <label>{t('legalForm')}<select required value={legalForm} onChange={event => { setLegalForm(event.target.value); prepareCorrectedAttempt() }}>
          <option value="EUN">{t('legalFormEU')}</option><option value="GMBH">GmbH</option><option value="UG">UG (haftungsbeschränkt)</option><option value="AG">AG</option>
        </select></label>
        {ledgerLoadState === 'loading' && <p role="status">{t('eBalanceLoading')}</p>}
        {[...ledgerIssues, ...requestIssues].length > 0 && <div className="error-summary" role="alert"><strong>{t('exportBlocked')}</strong><ul>{[...new Set([...ledgerIssues, ...requestIssues])].map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
        <button className="primary-action full" disabled={!canRunEBalanceAction(ledgerLoadState, ledgerIssues, exportBusy)}>{exportBusy ? t('eBalanceExporting') : t('createXbrlPackage')}</button>
        </fieldset>
      </form>
      <section className="panel"><div className="panel-title"><div><span className="step">{t('accountDetails')}</span><h2>{t('mappingCoverage')}</h2></div><strong className="coverage-number">{percent} %</strong></div>
        <div className="progress-track"><span style={{ width: `${percent}%` }} /></div><p>{t('mappingCount', { mapped: coverage.mapped, total: coverage.total })}</p>
        <hr /><div className="panel-title"><div><span className="step">ERiC 44 · Bilanz 6.9</span><h2>{t('officialValidation')}</h2></div><span className="taxonomy">{eric.testMode ? t('testMode') : t('productionMode')}</span></div>
        {eric.issues.length > 0 && <div className="legal-note"><strong>{t('ericSetupRequired')}</strong><ul>{eric.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
        {ericMessage && <p className="success" role="status">{ericMessage}</p>}
        <button type="button" className="secondary-action full" disabled={!eric.validationReady || !canRunEBalanceAction(ledgerLoadState, ledgerIssues, ericBusy)} onClick={() => void processWithEric(false)}>{ericBusy ? t('ericBusy') : t('validateWithEric')}</button>
        <label>{t('certificatePin')}<input type="password" autoComplete="off" value={pin} onChange={event => { setPin(event.target.value); prepareCorrectedAttempt() }} /></label>
        <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> {t('submissionConfirmation')}</label>
        <button type="button" className="primary-action full" disabled={!canSubmitEBalance(eric.submissionReady, fiscalYearStatus, confirmed, pin, history.some(item => item.kind === 'SUBMISSION' && isActiveSubmissionStatus(item.status)), submissionUncertain) || !canRunEBalanceAction(ledgerLoadState, ledgerIssues, ericBusy)} onClick={() => void processWithEric(true)}>{t('submitBinding')}</button>
        {history.length > 0 && <div><h3>{t('submissionHistory')}</h3><ul>{history.map(item => <li key={item.id}><strong>{item.kind === 'SUBMISSION' ? t('submission') : t('validation')}</strong> · {item.status} · {new Date(item.createdAt).toLocaleString()} {item.ericMessage ? `— ${item.ericMessage}` : ''}</li>)}</ul></div>}
        <div className="legal-note"><strong>{t('productBoundary')}</strong><p>{t('ericBoundary')}</p></div>
      </section>
    </div>
  </div>

  function prepareCorrectedAttempt() {
    const invalidated = invalidateReportApproval()
    setRequestIssues([])
    setConfirmed(invalidated.confirmed)
    setEricMessage(invalidated.message)
  }
}

export function canSubmitEBalance(submissionReady: boolean, fiscalYearStatus: string, confirmed: boolean, pin: string, activeSubmission = false, submissionUncertain = false) {
  return submissionReady && fiscalYearStatus === 'CLOSED' && confirmed && pin.length > 0 && !activeSubmission && !submissionUncertain
}

export function canRunEBalanceAction(loadState: LoadState, issues: string[], busy = false) {
  return loadState === 'ready' && issues.length === 0 && !busy
}

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
