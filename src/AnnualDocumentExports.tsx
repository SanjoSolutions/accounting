'use client'

import { useEffect, useId, useState } from 'react'

type Package = { id: string; kind: string; fiscalPeriodId?: string | null; version: number; status: string }
type Artifact = { id: string; version: number; provenance: string; createdAt: string; contentHash: string }
type Options = { packageId: string; checksum: string; company: string; fiscalYear: number; size: string; notes: string[]; policies: string[]; artifacts: Artifact[] }

export function AnnualDocumentExports({ packages, periods }: { packages: Package[]; periods: { id: string; label: string }[] }) {
  const approved = packages.filter(item => item.kind === 'ANNUAL_ACCOUNTS' && ['APPROVED', 'SUPERSEDED'].includes(item.status))
  const id = useId()
  const [selectedId, setSelectedId] = useState('')
  const packageId = approved.some(item => item.id === selectedId) ? selectedId : approved[0]?.id ?? ''
  const [options, setOptions] = useState<Options | null>(null)
  const [notes, setNotes] = useState<number[]>([])
  const [policies, setPolicies] = useState<number[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [establishedOn, setEstablishedOn] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const endpoint = `/api/compliance/packages/${encodeURIComponent(packageId)}/documents`
  useEffect(() => {
    const controller = new AbortController()
    setOptions(null); setNotes([]); setPolicies([]); setConfirmed(false); setEstablishedOn(''); setError('')
    if (packageId) fetch(endpoint, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? 'Abschluss konnte nicht geladen werden.'); return body.data
    }).then(setOptions).catch(cause => { if (!controller.signal.aborted) setError(String(cause.message)) })
    return () => controller.abort()
  }, [endpoint, packageId])
  const ready = options?.packageId === packageId
  async function create(mode: 'annual' | 'manual') {
    if (!ready || !options) return
    setBusy(true); setError('')
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, expectedChecksum: options.checksum, ...(mode === 'manual' ? { selection: { noteIndexes: notes, policyIndexes: policies, establishedOn, confirmedCompleteAndMinimized: confirmed } } : {}) }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? body.issues?.join(' ') ?? 'Export fehlgeschlagen.')
      setOptions(current => current?.packageId === packageId ? { ...current, artifacts: [body.data, ...current.artifacts] } : current)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Export fehlgeschlagen.') } finally { setBusy(false) }
  }
  const fileUrl = (artifact: Artifact, file: string) => `${endpoint}?artifactId=${encodeURIComponent(artifact.id)}&file=${encodeURIComponent(file)}`
  const checkboxes = (values: string[], chosen: number[], setter: (value: number[]) => void, prefix: string) => values.map((value, index) => <div className="form-check mb-2" key={index}><input className="form-check-input" type="checkbox" id={`${id}-${prefix}-${index}`} checked={chosen.includes(index)} disabled={busy} onChange={event => { setter(event.target.checked ? [...chosen, index] : chosen.filter(item => item !== index)); setConfirmed(false) }} /><label className="form-check-label" htmlFor={`${id}-${prefix}-${index}`}>{value}</label></div>)
  if (!approved.length) return null
  return <section lang="de" className="card mt-4" aria-labelledby={`${id}-heading`}><div className="card-body">
    <h3 id={`${id}-heading`} className="card-title">Jahresabschluss herunterladen</h3>
    <p className="text-body-secondary">Eine freigegebene Version auswählen. Neue Exporte benötigen den dazu passenden aktuellen Abschlusslauf. Gespeicherte Exporte bleiben als Archivstand abrufbar.</p>
    <label className="form-label" htmlFor={`${id}-version`}>Freigegebene Abschlussversion</label>
    <select className="form-select mb-3" id={`${id}-version`} value={packageId} disabled={busy} onChange={event => setSelectedId(event.target.value)}>{approved.map(item => <option value={item.id} key={item.id}>{periods.find(period => period.id === item.fiscalPeriodId)?.label ?? 'Geschäftsjahr'} · Version {item.version} · {item.id.slice(0, 8)}</option>)}</select>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}
    {ready && options && <>
      <p><strong>{options.company} · {options.fiscalYear}</strong><br /><span className="badge text-bg-secondary">Freigegeben</span> <span className="text-body-secondary">Ein Export bewirkt keine externe Einreichung.</span></p>
      <button className="btn btn-primary" disabled={busy} onClick={() => void create('annual')}>Vollständigen Jahresabschluss exportieren</button>
      <details className="mt-4"><summary>Manuelles Paket für das Unternehmensregister</summary>
        <div className="alert alert-info mt-3">{options.size === 'MICRO' ? 'Hinterlegung: Bilanz mit erforderlichen Angaben unter der Bilanz. Haftungsverhältnisse, Vorschüsse/Kredite an die Geschäftsführung und gegebenenfalls zusätzliche Angaben prüfen.' : 'Offenlegung: Bilanz und erforderlicher Anhang. Nur ausschließlich GuV-bezogene Angaben dürfen entfallen.'} Nur freigegebene Texte auswählen, die in diese Fassung gehören. Fehlende Angaben im Abschluss berichtigen und erneut freigeben.</div>
        <fieldset disabled={busy}><legend className="fs-6">Angaben für die Einreichung</legend>{checkboxes(options.notes, notes, setNotes, 'note')}</fieldset>
        {options.size === 'SMALL' && <fieldset disabled={busy}><legend className="fs-6">Bilanzierungs- und Bewertungsmethoden</legend>{checkboxes(options.policies, policies, setPolicies, 'policy')}</fieldset>}
        <label className="form-label mt-3" htmlFor={`${id}-established`}>Feststellungsdatum laut Gesellschafterbeschluss</label><input className="form-control" id={`${id}-established`} type="date" value={establishedOn} disabled={busy} onChange={event => { setEstablishedOn(event.target.value); setConfirmed(false) }} />
        <div className="form-check my-3"><input className="form-check-input" id={`${id}-confirm`} type="checkbox" disabled={busy} checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><label className="form-check-label" htmlFor={`${id}-confirm`}>Die Auswahl enthält sämtliche erforderlichen Angaben für diese Größenklasse und keine internen Belege oder ausschließlich GuV-bezogenen Angaben. Das Feststellungsdatum entspricht dem erfassten Beschluss.</label></div>
        <button className="btn btn-outline-primary" disabled={busy || !confirmed || !establishedOn || !notes.length || options.size === 'SMALL' && !policies.length} onClick={() => void create('manual')}>Minimiertes Einreichungspaket exportieren</button>
      </details>
      {!!options.artifacts.length && <div className="mt-4" aria-live="polite"><h4 className="fs-6">Gespeicherte Exporte</h4><ul className="list-group">{options.artifacts.map(artifact => <li className="list-group-item" key={artifact.id}><strong>{artifact.provenance === 'manual' ? 'Manuelles Einreichungspaket' : 'Vollständiger Jahresabschluss'}</strong> · Export {artifact.version}<p className="small text-body-secondary mb-2">Exportiert am {new Date(artifact.createdAt).toLocaleString('de-DE')} · keine Einreichungsbestätigung</p><div className="d-flex flex-wrap gap-2"><a className="btn btn-sm btn-outline-primary" href={fileUrl(artifact, artifact.provenance === 'manual' ? 'einreichung.html' : 'jahresabschluss.html')} target="_blank" rel="noreferrer">Druckansicht öffnen</a><a className="btn btn-sm btn-outline-secondary" href={fileUrl(artifact, 'bundle')} download>ZIP mit Manifest</a>{artifact.provenance === 'manual' && <a className="btn btn-sm btn-outline-secondary" href={fileUrl(artifact, 'ANLEITUNG.txt')} download>Einreichungsanleitung</a>}</div></li>)}</ul></div>}
    </>}
  </div></section>
}
