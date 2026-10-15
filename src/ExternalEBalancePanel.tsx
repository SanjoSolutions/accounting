'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import type { ExternalManifest } from './server/externalEBalance/adapter'

type Evidence = { id: string; kind: string; provider: string; occurredAt: string; trust: string }
type Package = { id: string; version: number; contentHash: string; createdAt: string; sourceStatus: 'CURRENT' | 'STALE'; manifest: ExternalManifest; evidence: Evidence[] }
type Overview = { ready: boolean; canWrite: boolean; issues: string[]; packages: Package[] }

async function jsonResponse(response: Response, fallback: string) {
  const value = await response.json()
  if (!response.ok) throw new Error(value.error ?? value.issues?.join(' ') ?? fallback)
  return value
}

export function ExternalEBalancePanel({ year }: { year: number }) {
  const t = useTranslations('ExternalEBalance')
  const evidenceLabels: Record<string, string> = { VALIDATION: t('validation'), TRANSMISSION: t('transmission'), ACCEPTANCE_CLAIM: t('acceptanceClaim') }
  const [overview, setOverview] = useState<Overview | null>(null)
  const [selection, setSelection] = useState('')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [pending, setPending] = useState<'create' | 'preview' | 'evidence' | null>(null)
  const [refreshing, setRefreshing] = useState(true)
  const [preview, setPreview] = useState('')
  const [previewName, setPreviewName] = useState('')
  const [reload, setReload] = useState(0)
  const root = `/api/fiscal-years/${year}/e-balance/external`
  const selected = overview?.packages.find(item => item.id === selection) ?? overview?.packages[0]
  const busy = pending !== null || refreshing

  useEffect(() => {
    const controller = new AbortController()
    setRefreshing(true)
    void fetch(root, { signal: controller.signal, cache: 'no-store' }).then(response => jsonResponse(response, t('requestFailed'))).then(value => {
      if (!controller.signal.aborted) { setOverview(value); setError('') }
    }).catch(error => { if (!controller.signal.aborted) setError(error.message) }).finally(() => { if (!controller.signal.aborted) setRefreshing(false) })
    return () => controller.abort()
  }, [root, reload, t])

  async function create() {
    setPending('create'); setError(''); setMessage('')
    try {
      const value = await jsonResponse(await fetch(root, { method: 'POST' }), t('exportFailed'))
      setSelection(value.id); setPreview(''); setReload(value => value + 1)
      setMessage(t('exportSaved', { version: value.version }))
    } catch (error) { setError(error instanceof Error ? error.message : t('exportFailed')) }
    finally { setPending(null) }
  }
  async function showPreview(name: string) {
    if (!selected) return
    setPending('preview'); setPreviewName(name); setError(''); setPreview('')
    try {
      const value = await jsonResponse(await fetch(`${root}/${selected.id}?preview=${encodeURIComponent(name)}`, { cache: 'no-store' }), t('previewFailed'))
      setPreviewName(name); setPreview(value.text)
    } catch (error) { setError(error instanceof Error ? error.message : t('previewFailed')) }
    finally { setPending(null) }
  }
  async function attach(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!selected) return
    const form = event.currentTarget; const data = new FormData(form)
    const date = new Date(String(data.get('occurredAt')))
    if (!Number.isFinite(date.getTime())) { setError(t('invalidDate')); return }
    data.set('occurredAt', date.toISOString()); data.set('packageHash', selected.contentHash)
    setPending('evidence'); setError(''); setMessage('')
    try {
      await jsonResponse(await fetch(`${root}/${selected.id}/evidence`, { method: 'POST', body: data }), t('evidenceFailed'))
      form.reset(); setReload(value => value + 1); setMessage(t('evidenceSaved'))
    } catch (error) { setError(error instanceof Error ? error.message : t('evidenceFailed')) }
    finally { setPending(null) }
  }
  const fileUrl = (name?: string) => `${root}/${selected?.id}${name ? `?file=${encodeURIComponent(name)}` : ''}`

  return <section className="card panel mb-4" aria-labelledby="external-ebilanz-title">
    <div className="panel-title"><div><span className="step">{t('externalFiling')}</span><h2 id="external-ebilanz-title">{t('title')}</h2></div><span className="badge text-bg-secondary">{t('format')}</span></div>
    <p>{t('intro')}</p>
    <p className="small text-body-secondary">{t('limitations')}</p>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {message && <p className="alert alert-info" role="status">{message}</p>}
    {!overview && !error && <p role="status">{t('checking')}</p>}
    {overview && <>
      {overview.issues.length > 0 && <div className="alert alert-warning"><strong>{t('notReady')}</strong><ul className="mb-0">{overview.issues.map(issue => <li key={issue}>{issue}</li>)}</ul><a href={`/annual-close/${year}`}>{t('reviewClose')}</a></div>}
      <div className="d-flex flex-wrap gap-2 mb-3">
        <button type="button" className="btn btn-primary" aria-busy={pending === 'create'} disabled={busy || !overview.ready || !overview.canWrite} onClick={() => void create()}>{t(pending === 'create' ? 'savingExport' : 'saveExport')}</button>
        <button type="button" className="btn btn-outline-secondary" aria-busy={refreshing} disabled={busy} onClick={() => setReload(value => value + 1)}>{t(refreshing ? 'refreshing' : 'refresh')}</button>
      </div>
      {!overview.canWrite && <p className="small">{t('readOnly')}</p>}
      {!selected ? <p>{t('empty')}</p> : <>
        <label className="form-label" htmlFor="external-package-version">{t('savedVersion')}</label>
        <select id="external-package-version" className="form-select mb-3" disabled={busy} value={selected.id} onChange={event => { setSelection(event.target.value); setPreview(''); setMessage('') }}>
          {overview.packages.map(item => <option key={item.id} value={item.id}>{t('versionOption', { version: item.version, source: t(item.sourceStatus === 'CURRENT' ? 'currentSource' : 'staleSource') })}</option>)}
        </select>
        {selected.sourceStatus === 'STALE' && <p className="alert alert-warning">{t('historical')}</p>}
        {selected.manifest.receiverLimitations.length > 0 && <div className="alert alert-warning"><strong>{t('manualAlternative')}</strong><ul className="mb-0">{selected.manifest.receiverLimitations.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
        <dl className="row mb-2">
          <dt className="col-sm-4">{t('export')}</dt><dd className="col-sm-8">{t('storedVersion', { version: selected.version })}</dd>
          <dt className="col-sm-4">{t('externalValidation')}</dt><dd className="col-sm-8">{selected.evidence.some(e => e.kind === 'VALIDATION') ? t('evidencePresent') : t('noEvidence')}</dd>
          <dt className="col-sm-4">{t('transmission')}</dt><dd className="col-sm-8">{selected.evidence.some(e => e.kind === 'TRANSMISSION') ? t('evidencePresent') : t('noEvidence')}</dd>
          <dt className="col-sm-4">{t('officialAcceptance')}</dt><dd className="col-sm-8">{t('unauthenticated')}</dd>
          <dt className="col-sm-4">{t('accountReconciliation')}</dt><dd className="col-sm-8">{t('reconciliationTotals', { count: selected.manifest.reconciliation.accountCount, difference: selected.manifest.reconciliation.differenceCents })}</dd>
          <dt className="col-sm-4">{t('packageHash')}</dt><dd className="col-sm-8 text-break"><code>{selected.contentHash}</code></dd>
        </dl>
        <div className="d-flex flex-wrap gap-2 mb-3">
          <a className="btn btn-primary" href={fileUrl()}>{t('downloadPackage')}</a>
          <a className="btn btn-outline-secondary" href={fileUrl('susa.csv')}>{t('trialBalanceCsv')}</a>
          <a className="btn btn-outline-secondary" href={fileUrl('e-bilanz.xbrl')}>XBRL</a>
          <button type="button" className="btn btn-outline-secondary" disabled={busy} onClick={() => void showPreview('ANLEITUNG.txt')}>{t('viewInstructions')}</button>
        </div>
        <details className="mb-3"><summary>{t('contents')}</summary>
          <ul className="list-group list-group-flush mt-2">{selected.manifest.files.map(file => <li className="list-group-item" key={file.name}>
            <div className="d-flex flex-wrap align-items-center gap-2"><a href={fileUrl(file.name)}>{file.name}</a>{!file.name.endsWith('.zip') && <button type="button" className="btn btn-sm btn-link" disabled={busy} onClick={() => void showPreview(file.name)}>{t('previewFile', { name: file.name })}</button>}</div>
            <small className="text-break">SHA-256: {file.sha256}</small>
          </li>)}</ul>
        </details>
        {pending === 'preview' && <p role="status">{t('loadingPreview', { name: previewName })}</p>}
        {preview && <div className="mb-3"><h3 className="h6">{t('previewTitle', { name: previewName })}</h3><pre className="border rounded p-3 bg-body-tertiary" style={{ maxHeight: '24rem', overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview}</pre></div>}
        <details><summary>{t('recordEvidence', { version: selected.version })}</summary>
          <p className="small mt-2">{t('evidenceIntro')}</p>
          <form onSubmit={attach} key={selected.id} aria-busy={pending === 'evidence'}>
            <fieldset disabled={busy || !overview.canWrite} className="row g-3">
              <div className="col-md-6"><label className="form-label" htmlFor="external-evidence-kind">{t('evidenceKind')}</label><select className="form-select" id="external-evidence-kind" name="kind">{Object.entries(evidenceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
              <div className="col-md-6"><label className="form-label" htmlFor="external-provider">{t('provider')}</label><input className="form-control" id="external-provider" name="provider" defaultValue="myebilanz" maxLength={120} required /></div>
              <div className="col-md-6"><label className="form-label" htmlFor="external-occurred">{t('occurredAt')}</label><input className="form-control" id="external-occurred" name="occurredAt" type="datetime-local" required /></div>
              <div className="col-md-6"><label className="form-label" htmlFor="external-file">{t('evidenceFile')}</label><input className="form-control" id="external-file" name="file" type="file" required /></div>
              <div className="col-12"><label className="form-label" htmlFor="external-note">{t('evidenceNote')}</label><textarea className="form-control" id="external-note" name="note" maxLength={2000} required /></div>
              <div className="col-12"><div className="form-check"><input className="form-check-input" id="external-confirm" name="confirmSource" type="checkbox" value="true" required /><label className="form-check-label" htmlFor="external-confirm">{t('confirmSource')}</label></div></div>
              <div className="col-12"><button className="btn btn-outline-primary">{t(pending === 'evidence' ? 'savingEvidence' : 'saveEvidence')}</button></div>
            </fieldset>
          </form>
        </details>
        {selected.evidence.length > 0 && <ul className="list-group list-group-flush mt-3">{selected.evidence.map(item => <li className="list-group-item" key={item.id}>{evidenceLabels[item.kind]} · {item.provider} · {t('unauthenticated')} <a href={`${root}/${selected.id}/evidence?evidenceId=${encodeURIComponent(item.id)}`}>{t('downloadEvidence')}</a></li>)}</ul>}
      </>}
    </>}
  </section>
}
