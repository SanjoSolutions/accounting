"use client"

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { FiscalYearNavigation } from './FiscalYearNavigation'

type CloseData = {
  fiscalYear: { year: number; status: string; lockedAt: string | null }
  closingIssues: string[]
  statements: { assetsCents: number; liabilitiesCents: number; equityCents: number; revenueCents: number; expenseCents: number; netIncomeCents: number; balanceDifferenceCents: number }
  entries?: unknown[]
}
const money = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' })

export function getCloseSteps(data: CloseData | null, t: (key: string) => string = key => key) {
  const ready = Boolean(data && data.closingIssues.length === 0)
  const closed = data?.fiscalYear.status === 'CLOSED'
  return [
    { title: t('bookingJournal'), detail: data?.entries?.length ? t('journalComplete') : t('journalEmpty'), done: Boolean(data?.entries?.length) },
    { title: t('accountsTaxonomy'), detail: ready ? t('accountsMapped') : t('plausibilityBlocked'), done: ready },
    { title: t('balanceAndIncome'), detail: ready ? t('statementsBalanced') : t('plausibilityBlocked'), done: ready },
    { title: t('approvalAndLock'), detail: closed ? t('yearImmutable') : t('approvalPending'), done: closed },
  ]
}

export function AnnualCloseWorkspace({ year }: { year: number }) {
  const t = useTranslations('Workspaces')
  const [data, setData] = useState<CloseData | null>(null)
  const [issues, setIssues] = useState<string[]>([])
  const [closeError, setCloseError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const yearRef = useRef(year)
  const operationRef = useRef(0)
  const loadRef = useRef(0)
  const load = useCallback(async (signal?: AbortSignal) => {
    const requestedYear = year
    if (requestedYear !== yearRef.current) return
    const generation = ++loadRef.current
    setLoading(true); setData(null)
    try {
      const response = await fetch(`/api/booking-records?year=${requestedYear}`, { signal })
      if (!response.ok) throw new Error('load failed')
      const body = await response.json()
      if (generation === loadRef.current && requestedYear === yearRef.current && !signal?.aborted) { setData(body); setIssues(body.closingIssues) }
    } catch (error) { if ((error as { name?: string }).name !== 'AbortError' && generation === loadRef.current && requestedYear === yearRef.current) setIssues([t('closeFailed')]) }
    finally { if (generation === loadRef.current && requestedYear === yearRef.current && !signal?.aborted) setLoading(false) }
  }, [year])
  useEffect(() => { yearRef.current = year; operationRef.current++; setBusy(false); setCloseError(''); const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [load, year])

  async function close() {
    if (!confirm(t('closeConfirm', { year }))) return
    const requestedYear = year
    const operation = ++operationRef.current
    setBusy(true); setCloseError('')
    try {
      const response = await fetch(`/api/fiscal-years/${year}/close`, { method: 'POST' })
      if (!response.ok) {
        const body = await response.json()
        if (operationRef.current === operation && yearRef.current === requestedYear) {
          if (Array.isArray(body.issues) && body.issues.length) setIssues(body.issues)
          else setCloseError(t('closeFailed'))
        }
        return
      }
      // A successful close is authoritative. If this year became active again,
      // reconcile it even when the originating UI generation is now obsolete.
      if (yearRef.current === requestedYear) await load()
    } catch { if (operationRef.current === operation && yearRef.current === requestedYear) setCloseError(t('closeFailed')) }
    finally { if (operationRef.current === operation && yearRef.current === requestedYear) setBusy(false) }
  }

  const currentData = data?.fiscalYear.year === year ? data : null
  const unavailable = !currentData
  const transitioning = unavailable && (loading || data !== null)
  const displayIssues = currentData && !currentData.entries?.length ? [...new Set([...issues, t('journalEmpty')])] : issues
  const steps = getCloseSteps(currentData ? { ...currentData, closingIssues: displayIssues } : null, key => t(key))
  return <div className="workspace pb-4">
    <FiscalYearNavigation area="annual-close" year={year} />
    <header className="page-heading"><div><span className="eyebrow">{t('guidedClose')}</span><h1>{t('annualClose', { year })}</h1><p>{t('annualCloseSubtitle')}</p></div><span className={`status ${currentData?.fiscalYear.status.toLowerCase() ?? 'loading'}`}>{currentData?.fiscalYear.status === 'CLOSED' ? t('locked') : currentData ? t('inProgress') : transitioning ? t('closingBusy') : t('closeFailed')}</span></header>
    <div className="close-grid">
      <section className="card panel close-steps"><h2>{t('closeProgress')}</h2>{steps.map((step, index) => <div className="close-step" key={step.title}><span className={step.done ? 'done' : ''}>{step.done ? '✓' : index + 1}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div></div>)}</section>
      <section className="card panel statement-preview"><div className="panel-title"><div><span className="step">{t('automaticallyCalculated')}</span><h2>{t('statements')}</h2></div></div>
        {currentData && <dl><Statement label={t('assets')} value={currentData.statements.assetsCents} /><Statement label={t('liabilities')} value={currentData.statements.liabilitiesCents} /><Statement label={t('equityIncludingResult')} value={currentData.statements.equityCents} /><Statement label={t('revenue')} value={currentData.statements.revenueCents} /><Statement label={t('expenses')} value={currentData.statements.expenseCents} /><Statement label={t('annualResult')} value={currentData.statements.netIncomeCents} important /></dl>}
      </section>
    </div>
    <section className={`card panel readiness ${unavailable || displayIssues.length ? 'blocked' : 'ready'}`}>
      <div><span className="eyebrow">{t('closeReview')}</span><h2>{transitioning ? t('closingBusy') : unavailable ? t('closeFailed') : displayIssues.length ? t('closeBlockers', { count: displayIssues.length }) : t('readyForApproval')}</h2>
      {!unavailable && (displayIssues.length ? <ul>{displayIssues.map(issue => <li key={issue}>{issue}</li>)}</ul> : <p>{t('professionalReviewNote')}</p>)}</div>
      {closeError && <p className="alert alert-danger" role="alert">{closeError}</p>}
      <div className="action-stack"><Link className="btn btn-outline-secondary" href={`/e-bilanz/${year}`}>{t('reviewEBalance')}</Link><button className="btn btn-primary" disabled={!canCloseYear(data, displayIssues, loading, busy, year)} onClick={close}>{data?.fiscalYear.status === 'CLOSED' ? t('yearLocked') : busy ? t('closingBusy') : t('reviewAndLock')}</button></div>
    </section>
  </div>
}
export function canCloseYear(data: CloseData | null, issues: string[], loading: boolean, busy: boolean, selectedYear = data?.fiscalYear.year) {
  return Boolean(data && data.fiscalYear.year === selectedYear && data.entries?.length && !loading && !busy && issues.length === 0 && data.fiscalYear.status === 'OPEN')
}
function Statement({ label, value = 0, important = false }: { label: string; value?: number; important?: boolean }) { return <div className={important ? 'important' : ''}><dt>{label}</dt><dd>{money.format(value / 100)}</dd></div> }
