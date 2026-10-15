'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { PageHeading } from './PageHeading'
import { LocalCurrency } from './LocalNumber'
import { LocalDate } from './LocalDate'
import { EUER_POSITIONS, euerDecimal, euerPositionsForVatRegime, type EuerEntry, type EuerReport } from './core/euer'
import { parseEuerAmount } from './euerForm'

type Workspace = { version: number; report: EuerReport; locked: boolean; profileChanged: boolean; currentVatRegime: string; history: { version: number; createdAt: string; createdBy: string }[] }
type SaveRequest = { year: number; baseVersion: number; requestKey: string; input: { entries: EuerEntry[]; scopeConfirmed: boolean } }

export function EuerWorkspace({ year }: { year: number }) {
  const t = useTranslations('Euer')
  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [entries, setEntries] = useState<EuerEntry[]>([])
  const [canWrite, setCanWrite] = useState(false)
  const [scopeConfirmed, setScopeConfirmed] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const pending = useRef<SaveRequest | null>(null)
  const [entry, setEntry] = useState({ paymentDate: `${year}-01-01`, position: 'taxableReceipts', amount: '', reference: '', description: '', recurring: false, dueDate: '', economicYear: year })
  const load = useCallback(async () => {
    const response = await fetch(`/api/tax/euer?year=${year}`)
    const body = await response.json()
    if (!response.ok) throw new Error(body.issues?.join(' ') ?? t('failed'))
    const data = body.data as Workspace
    setWorkspace(data); setCanWrite(body.canWrite); setEntries(data.report.input.entries)
    setScopeConfirmed(!data.profileChanged && data.report.input.scopeConfirmed); setDirty(data.profileChanged)
    setEntry(current => ({ ...current, position: data.currentVatRegime === 'SMALL_BUSINESS' ? 'smallBusinessReceipts' : data.currentVatRegime === 'EXEMPT' ? 'exemptReceipts' : 'taxableReceipts' }))
  }, [year, t])
  useEffect(() => { void load().catch(error => setError(error.message)) }, [load])
  const disabled = !canWrite || busy || uncertain || Boolean(workspace?.locked)
  function changed() { setDirty(true); setScopeConfirmed(false); setNotice(''); setError('') }
  function add(event: FormEvent) {
    event.preventDefault()
    try {
      const amountCents = parseEuerAmount(entry.amount)
      setEntries(current => [...current, { id: crypto.randomUUID(), paymentDate: entry.paymentDate, position: entry.position, amountCents, reference: entry.reference, description: entry.description, ...(entry.recurring ? { recurring: { dueDate: entry.dueDate, economicYear: entry.economicYear } } : {}) }])
      setEntry(current => ({ ...current, amount: '', reference: '', description: '' })); changed()
    } catch { setError(t('invalidAmount')) }
  }
  async function save() {
    if (!workspace) return
    setBusy(true); setError(''); setNotice('')
    const request = pending.current ?? { year, baseVersion: workspace.version, requestKey: crypto.randomUUID(), input: { entries, scopeConfirmed } }
    pending.current = request
    try {
      const response = await fetch('/api/tax/euer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(30_000) })
      if (response.status >= 400 && response.status < 500) { pending.current = null; setUncertain(false) }
      const body = await response.json()
      if (!response.ok) throw new Error(body.issues?.join(' ') ?? t('failed'))
      if (!body.data?.version || !body.data.report) throw new Error(t('failed'))
      pending.current = null; setUncertain(false)
      setWorkspace(current => current && ({ ...current, version: body.data.version, report: body.data.report, profileChanged: false, history: [{ version: body.data.version, createdAt: new Date().toISOString(), createdBy: '' }, ...current.history.filter(row => row.version !== body.data.version)] }))
      setDirty(false); setNotice(t('saved', { version: body.data.version }))
    } catch (error) { setUncertain(Boolean(pending.current)); setError(error instanceof Error ? error.message : t('failed')) }
    finally { setBusy(false) }
  }
  async function download() {
    if (!workspace) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/tax/euer?year=${year}&format=csv&version=${workspace.version}`)
      if (!response.ok) { const body = await response.json(); throw new Error(body.issues?.join(' ') ?? t('failed')) }
      const url = URL.createObjectURL(await response.blob()); const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `euer-${year}.csv`; anchor.click(); URL.revokeObjectURL(url)
    } catch (error) { setError(error instanceof Error ? error.message : t('failed')) }
    finally { setBusy(false) }
  }
  return <div className="workspace pb-4" aria-busy={busy || !workspace && !error}>
    <PageHeading title={t('title', { year })} subtitle={t('subtitle')}><Link href={`/tax/${year}`} className="btn btn-outline-secondary">{t('back')}</Link></PageHeading>
    {error && <div className="alert alert-danger" role="alert">{error} {!workspace && <Link href="/compliance">{t('configure')}</Link>}</div>}
    {notice && <p className="alert alert-success" role="status">{notice}</p>}
    {busy && <p role="status">{t('working')}</p>}
    {uncertain && <p className="alert alert-warning" role="status">{t('uncertain')}</p>}
    {!workspace && !error && <p role="status">{t('loading')}</p>}
    {workspace && <>
      <p className="alert alert-info">{t('manual')}</p>
      {workspace.profileChanged && <p className="alert alert-warning" role="status">{t('profileChanged')}</p>}
      {workspace.locked && <p className="alert alert-warning" role="status">{t('locked')}</p>}
      <section className="card p-3 mb-3">
        <h2 className="h4">{t('entries')}</h2>
        <p>{t(workspace.currentVatRegime === 'STANDARD' ? 'netHelp' : 'grossHelp')}</p>
        <p className="text-muted">{t('timingHelp')}</p>
        <p className="text-muted small">{t('officialLabels')}</p>
        <form onSubmit={add}>
          <fieldset disabled={disabled}>
            <div className="row g-3">
              <label className="col-sm-4">{t('paymentDate')}<input className="form-control" type="date" required value={entry.paymentDate} onChange={event => setEntry({ ...entry, paymentDate: event.target.value })} /></label>
              <label className="col-sm-8">{t('position')}<select className="form-select" value={entry.position} onChange={event => setEntry({ ...entry, position: event.target.value, recurring: ['deposits', 'withdrawals'].includes(event.target.value) ? false : entry.recurring })}>{euerPositionsForVatRegime(workspace.currentVatRegime).map(item => <option key={item.key} value={item.key}>{year === 2025 ? item.line2025 : item.line2026} · {item.label}</option>)}</select></label>
              <label className="col-sm-4">{t('amount')}<input className="form-control" inputMode="decimal" required value={entry.amount} onChange={event => setEntry({ ...entry, amount: event.target.value })} placeholder="0,00" /></label>
              <label className="col-sm-4">{t('reference')}<input className="form-control" required maxLength={200} value={entry.reference} onChange={event => setEntry({ ...entry, reference: event.target.value })} /></label>
              <label className="col-sm-4">{t('description')}<input className="form-control" required maxLength={300} value={entry.description} onChange={event => setEntry({ ...entry, description: event.target.value })} /></label>
            </div>
            <div className="form-check my-3"><input id="euer-recurring" className="form-check-input" type="checkbox" checked={entry.recurring} disabled={['deposits', 'withdrawals'].includes(entry.position)} onChange={event => setEntry({ ...entry, recurring: event.target.checked })} /><label htmlFor="euer-recurring" className="form-check-label">{t('recurring')}</label></div>
            {entry.recurring && <div className="row g-3 mb-3">
              <label className="col-sm-6">{t('dueDate')}<input className="form-control" type="date" required value={entry.dueDate} onChange={event => setEntry({ ...entry, dueDate: event.target.value })} /></label>
              <label className="col-sm-6">{t('economicYear')}<input className="form-control" type="number" required min={year - 1} max={year + 1} value={entry.economicYear} onChange={event => setEntry({ ...entry, economicYear: Number(event.target.value) })} /></label>
            </div>}
            <button className="btn btn-outline-primary">{t('add')}</button>
          </fieldset>
        </form>
        <div className="table-responsive mt-3"><table className="table align-middle caption-top"><caption>{t('entryCount', { count: entries.length })}</caption><thead><tr><th>{t('paymentDate')}</th><th>{t('position')}</th><th>{t('reference')}</th><th className="text-end">{t('amount')}</th><th>{t('actions')}</th></tr></thead>
          <tbody>{entries.map(item => <tr key={item.id}><td><LocalDate value={item.paymentDate} />{item.recurring && <div className="small">{t('assignedYear', { year: item.recurring.economicYear })}</div>}</td><td>{EUER_POSITIONS.find(position => position.key === item.position)?.label}<div className="text-muted small">{item.description}</div></td><td>{item.reference}</td><td className="text-end text-nowrap"><LocalCurrency cents={item.amountCents} currency="EUR" /></td><td><button type="button" className="btn btn-sm btn-outline-danger" disabled={disabled} aria-label={t('removeEntry', { reference: item.reference })} onClick={() => { setEntries(current => current.filter(row => row.id !== item.id)); changed() }}>{t('remove')}</button></td></tr>)}</tbody>
        </table></div>
      </section>
      <section className="card p-3 mb-3">
        <h2 className="h4">{t('review')}</h2><p>{t('scope')}</p>
        <div className="form-check mb-3"><input id="euer-scope" className="form-check-input" type="checkbox" checked={scopeConfirmed} disabled={disabled} onChange={event => { setScopeConfirmed(event.target.checked); setDirty(true) }} /><label className="form-check-label" htmlFor="euer-scope">{t('confirm')}</label></div>
        <div className="d-flex flex-wrap gap-2"><button type="button" className="btn btn-primary" disabled={!canWrite || busy || workspace.locked || (!dirty && !uncertain && workspace.version > 0)} onClick={() => void save()}>{t(uncertain ? 'retry' : 'save')}</button>
          <button type="button" className="btn btn-outline-secondary" disabled={busy || dirty || uncertain || !workspace.version || workspace.profileChanged || !workspace.report.input.scopeConfirmed} onClick={() => void download()}>{t('download')}</button></div>
      </section>
      {workspace.version > 0 && <section className="card p-3 mb-3">
        <h2 className="h4">{t('copyTitle', { version: workspace.version })}</h2>
        {!workspace.report.input.scopeConfirmed && <p className="alert alert-warning" role="status">{t('draft')}</p>}
        {dirty && <p className="alert alert-warning" role="status">{t('unsaved')}</p>}
        <p>{workspace.report.companyName} · {workspace.report.taxNumber}</p>
        <p>{workspace.report.activity} · {t(workspace.report.incomeType === 'TRADE' ? 'trade' : 'selfEmployed')}</p>
        <div className="table-responsive"><table className="table"><thead><tr><th>{t('line')}</th><th>{t('code')}</th><th>{t('position')}</th><th className="text-end">EUR</th></tr></thead>
          <tbody>{workspace.report.positions.filter(item => item.amountCents !== 0).map(item => <tr key={item.key}><td>{item.line}</td><td>{item.code}</td><td>{item.label}</td><td className="text-end text-nowrap">{euerDecimal(item.amountCents)}</td></tr>)}</tbody>
          <tfoot><tr><th colSpan={3}>{t('income')}</th><td className="text-end">{euerDecimal(workspace.report.incomeCents)}</td></tr><tr><th colSpan={3}>{t('expenses')}</th><td className="text-end">{euerDecimal(workspace.report.expenseCents)}</td></tr><tr><th colSpan={3}>{t('profit')}</th><td className="text-end fw-bold">{euerDecimal(workspace.report.profitCents)}</td></tr></tfoot>
        </table></div>
        <p className="mb-0"><a href={workspace.report.sourceUrl} target="_blank" rel="noreferrer">{t('officialForm')}</a> · <a href="https://www.elster.de/eportal/formulare-leistungen/alleformulare/euer" target="_blank" rel="noreferrer">Mein ELSTER</a></p>
      </section>}
      {workspace.history.length > 0 && <details className="card p-3"><summary>{t('history')}</summary><ul className="mb-0 mt-2">{workspace.history.map(item => <li key={item.version}>{t('version', { version: item.version })} · <LocalDate value={item.createdAt} /></li>)}</ul></details>}
    </>}
  </div>
}
