"use client"

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'

type Profile = {
  companyName: string; legalForm: string; registerCourt?: string; registerNumber?: string; taxNumber: string; vatId?: string; taxOffice: string
  registeredAddress?: { streetAndHouseNumber: string; zipCode: string; city: string; country: string }
  vatRegime: string; vatFilingFrequency: string; activity: string; sizeClass: string; chart: string; elections: string[]; applicabilityOverrides?: Record<string, boolean>
}
type Overview = {
  tenantId: string
  profile: { value: Profile; applicability: Record<string, { applicable: boolean; basis: string; overridden: boolean }> } | null
  periods: Array<{ id: string; referenceYear: number; label: string; startsAt: string; endsAt: string; status: string }>
  chart: { chart: string; mappings: unknown[] } | null
  audit: { verified: boolean; events: unknown[] }
  operations: { policy: unknown; profileAddressMigrations?: Array<{ id: string; effectiveFrom: string; confirmed: boolean }>; artifacts: Array<{ id: string; objectType: string; objectId: string; retainUntil: string; legalHoldUntil?: string; disposedAt?: string }>; drafts: Array<{ id: string; status: string; version: number }>; reopenRequests: Array<{ id: string; status: string; fiscalYearId: string }>; amendments: Array<{ id: string; kind: string; status: string }>; backups: Array<{ id: string; status: string; storageRegion: string; recoveryPointAt: string }> }
}

export const complianceHref = '/compliance'
export const EMPTY_PROFILE: Profile = { companyName: '', legalForm: 'SOLE_TRADER', taxNumber: '', taxOffice: '', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: '', sizeClass: 'MICRO', chart: 'SKR03', elections: [] }

export function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('JSON object required')
  return parsed as Record<string, unknown>
}

export async function requestComplianceAction(payload: Record<string, unknown>) {
  const response = await fetch('/api/compliance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error ?? body.issues?.join('; ') ?? 'Compliance action failed')
  return body.data
}

export function ComplianceWorkspace() {
  const t = useTranslations('Compliance')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE)
  const [reason, setReason] = useState('')
  const [overridesText, setOverridesText] = useState('{}')
  const [period, setPeriod] = useState({ referenceYear: new Date().getFullYear(), label: '', startsAt: `${new Date().getFullYear()}-01-01`, endsAt: `${new Date().getFullYear()}-12-31`, reason: '' })
  const [customChartId, setCustomChartId] = useState('CUSTOM:')
  const [customMappings, setCustomMappings] = useState('[\n  {"accountNumber": 1000, "name": "Cash", "accountType": "ASSET", "normalBalance": "DEBIT", "hgbPosition": "HGB.266", "eBilanzPosition": "bs.ass.currAss.cashEquiv.cash"}\n]')
  const [operation, setOperation] = useState('draft.create')
  const [operationPayload, setOperationPayload] = useState('{}')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const operationExamples = useMemo(() => complianceOperationExamples(overview), [overview])
  useEffect(() => { setOperationPayload(JSON.stringify(operationExamples[operation] ?? {}, null, 2)) }, [operation, operationExamples])
  useEffect(() => { void refresh() }, [])

  async function refresh() {
    setError('')
    try {
      const [settingsResponse, overviewResponse] = await Promise.all([fetch('/api/settings'), fetch('/api/compliance')])
      const settingsBody = await settingsResponse.json(); const overviewBody = await overviewResponse.json()
      if (!settingsResponse.ok || !overviewResponse.ok) throw new Error(overviewBody.error ?? t('loadFailed'))
      const next = overviewBody.data as Overview
      setOverview(next)
      const nextProfile = next.profile?.value ?? settingsBody.data.companyProfile ?? EMPTY_PROFILE
      setProfile(nextProfile)
      setOverridesText(JSON.stringify(nextProfile.applicabilityOverrides ?? {}, null, 2))
    } catch (caught) { setError(caught instanceof Error ? caught.message : t('loadFailed')) }
  }

  async function execute(task: () => Promise<unknown>, message: string) {
    setBusy(true); setError(''); setSuccess('')
    try { await task(); setSuccess(message); await refresh() }
    catch (caught) { setError(caught instanceof Error ? caught.message : t('actionFailed')) }
    finally { setBusy(false) }
  }

  async function saveProfile(event: FormEvent) {
    event.preventDefault()
    await execute(async () => {
      if (!reason.trim()) throw new Error(t('reasonRequired'))
      const applicabilityOverrides = parseJsonObject(overridesText)
      if (Object.values(applicabilityOverrides).some(value => typeof value !== 'boolean')) throw new Error(t('overrideBooleanRequired'))
      const profileToSave = { ...profile, applicabilityOverrides }
      const response = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ companyProfile: profileToSave, companyProfileEffectiveFrom: new Date().toISOString().slice(0, 10), changeReason: reason }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? t('actionFailed'))
      setReason('')
    }, t('profileSaved'))
  }

  async function createPeriod(event: FormEvent) {
    event.preventDefault(); await execute(() => requestComplianceAction({ action: 'period.create', ...period }), t('periodCreated'))
  }

  async function activateCustomChart(event: FormEvent) {
    event.preventDefault(); await execute(async () => {
      if (!reason.trim()) throw new Error(t('reasonRequired'))
      const mappings = JSON.parse(customMappings) as unknown
      if (!Array.isArray(mappings)) throw new Error(t('mappingArrayRequired'))
      const nextProfile = { ...profile, chart: customChartId }
      const today = new Date().toISOString().slice(0, 10)
      const response = await fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ importedChart: { id: customChartId, mappings }, mappingEffectiveFrom: today, companyProfile: nextProfile, companyProfileEffectiveFrom: today, changeReason: reason }) })
      const body = await response.json(); if (!response.ok) throw new Error(body.error ?? t('actionFailed'))
      setProfile(nextProfile); setReason('')
    }, t('chartActivated'))
  }

  async function runOperation(event: FormEvent) {
    event.preventDefault(); await execute(() => requestComplianceAction({ action: operation, ...parseJsonObject(operationPayload) }), t('operationCompleted'))
  }

  const applicability = overview?.profile?.applicability ?? {}
  return <div className="workspace py-4 compliance-workspace">
    <header className="page-heading"><div><span className="eyebrow">{t('eyebrow')}</span><h1>{t('title')}</h1><p>{t('subtitle')}</p></div><button type="button" className="btn btn-outline-secondary" disabled={busy} onClick={() => void refresh()}>{t('refresh')}</button></header>
    {error && <div className="error-summary" role="alert">{error}</div>}
    {success && <p className="success" role="status">{success}</p>}

    <section className="panel"><div className="panel-title"><div><span className="step">1</span><h2>{t('profile')}</h2></div><span className={`status ${overview?.audit.verified ? 'closed' : 'open'}`}>{overview?.audit.verified ? t('auditVerified') : t('auditUnverified')}</span></div>
      <form onSubmit={saveProfile}>
        <div className="form-grid">
          <Text label={t('companyName')} value={profile.companyName} onChange={companyName => setProfile({ ...profile, companyName })} />
          <Text label={t('street')} value={profile.registeredAddress?.streetAndHouseNumber ?? ''} onChange={streetAndHouseNumber => setProfile({ ...profile, registeredAddress: { streetAndHouseNumber, zipCode: profile.registeredAddress?.zipCode ?? '', city: profile.registeredAddress?.city ?? '', country: profile.registeredAddress?.country ?? 'DE' } })} />
          <Text label={t('postalCode')} value={profile.registeredAddress?.zipCode ?? ''} onChange={zipCode => setProfile({ ...profile, registeredAddress: { streetAndHouseNumber: profile.registeredAddress?.streetAndHouseNumber ?? '', zipCode, city: profile.registeredAddress?.city ?? '', country: profile.registeredAddress?.country ?? 'DE' } })} />
          <Text label={t('city')} value={profile.registeredAddress?.city ?? ''} onChange={city => setProfile({ ...profile, registeredAddress: { streetAndHouseNumber: profile.registeredAddress?.streetAndHouseNumber ?? '', zipCode: profile.registeredAddress?.zipCode ?? '', city, country: profile.registeredAddress?.country ?? 'DE' } })} />
          <Text label={t('country')} value={profile.registeredAddress?.country ?? ''} onChange={country => setProfile({ ...profile, registeredAddress: { streetAndHouseNumber: profile.registeredAddress?.streetAndHouseNumber ?? '', zipCode: profile.registeredAddress?.zipCode ?? '', city: profile.registeredAddress?.city ?? '', country } })} />
          <Select label={t('legalForm')} value={profile.legalForm} values={['SOLE_TRADER', 'GMBH', 'UG', 'AG', 'OHG', 'KG', 'GBR', 'PARTNERSHIP', 'OTHER']} onChange={legalForm => setProfile({ ...profile, legalForm })} />
          <Text label={t('registerCourt')} value={profile.registerCourt ?? ''} onChange={registerCourt => setProfile({ ...profile, registerCourt: registerCourt || undefined })} />
          <Text label={t('registerNumber')} value={profile.registerNumber ?? ''} onChange={registerNumber => setProfile({ ...profile, registerNumber: registerNumber || undefined })} />
          <Text label={t('taxNumber')} value={profile.taxNumber} onChange={taxNumber => setProfile({ ...profile, taxNumber })} />
          <Text label={t('vatId')} value={profile.vatId ?? ''} onChange={vatId => setProfile({ ...profile, vatId: vatId || undefined })} />
          <Text label={t('taxOffice')} value={profile.taxOffice} onChange={taxOffice => setProfile({ ...profile, taxOffice })} />
          <Select label={t('vatRegime')} value={profile.vatRegime} values={['STANDARD', 'SMALL_BUSINESS', 'EXEMPT']} onChange={vatRegime => setProfile({ ...profile, vatRegime })} />
          <Select label={t('filingFrequency')} value={profile.vatFilingFrequency} values={['MONTHLY', 'QUARTERLY', 'ANNUAL']} onChange={vatFilingFrequency => setProfile({ ...profile, vatFilingFrequency })} />
          <Text label={t('activity')} value={profile.activity} onChange={activity => setProfile({ ...profile, activity })} />
          <Select label={t('sizeClass')} value={profile.sizeClass} values={['MICRO', 'SMALL', 'MEDIUM', 'LARGE']} onChange={sizeClass => setProfile({ ...profile, sizeClass })} />
          <Text label={t('chart')} value={profile.chart} onChange={chart => setProfile({ ...profile, chart })} />
          <Text label={t('elections')} value={profile.elections.join(', ')} onChange={value => setProfile({ ...profile, elections: value.split(',').map(item => item.trim()).filter(Boolean) })} />
          <label className="full-width">{t('applicabilityOverrides')}<textarea rows={4} value={overridesText} onChange={event => setOverridesText(event.target.value)} /></label>
          <Text label={t('changeReason')} value={reason} onChange={setReason} required />
        </div><button className="primary-action" disabled={busy}>{t('saveProfile')}</button>
      </form>
      <div className="table-responsive"><table className="table"><thead><tr><th>{t('report')}</th><th>{t('applicable')}</th><th>{t('basis')}</th></tr></thead><tbody>{Object.entries(applicability).map(([kind, item]) => <tr key={kind}><td>{kind}</td><td>{item.applicable ? t('yes') : t('no')}</td><td>{item.overridden ? t('override') : item.basis}</td></tr>)}</tbody></table></div>
    </section>

    <section className="panel"><div className="panel-title"><div><span className="step">2</span><h2>{t('periods')}</h2></div><span className="hint">{t('periodHint')}</span></div>
      <form onSubmit={createPeriod}><div className="form-grid"><Text label={t('referenceYear')} type="number" value={String(period.referenceYear)} onChange={referenceYear => setPeriod({ ...period, referenceYear: Number(referenceYear) })} /><Text label={t('label')} value={period.label} onChange={label => setPeriod({ ...period, label })} /><Text label={t('startsAt')} type="date" value={period.startsAt} onChange={startsAt => setPeriod({ ...period, startsAt })} /><Text label={t('endsAt')} type="date" value={period.endsAt} onChange={endsAt => setPeriod({ ...period, endsAt })} /><Text label={t('reason')} value={period.reason} onChange={reason => setPeriod({ ...period, reason })} required /></div><button className="primary-action" disabled={busy}>{t('createPeriod')}</button></form>
      <ul className="history-list">{overview?.periods.map(item => <li key={item.id}><strong>{item.label}</strong> · {item.startsAt}–{item.endsAt} · {item.status}<br/><code>{item.id}</code></li>)}</ul>
    </section>

    <section className="panel"><div className="panel-title"><div><span className="step">3</span><h2>{t('chartLifecycle')}</h2></div><span className="hint">{overview?.chart?.chart ?? '—'}</span></div>
      <form onSubmit={activateCustomChart}><div className="form-grid"><Text label={t('customChartId')} value={customChartId} onChange={setCustomChartId} required /><label className="full-width">{t('mappingJson')}<textarea rows={8} value={customMappings} onChange={event => setCustomMappings(event.target.value)} /></label><Text label={t('changeReason')} value={reason} onChange={setReason} required /></div><button className="primary-action" disabled={busy}>{t('activateChart')}</button></form>
      <details><summary>{t('mappingHistory')} ({overview?.chart?.mappings.length ?? 0})</summary><pre>{JSON.stringify(overview?.chart?.mappings ?? [], null, 2)}</pre></details>
    </section>

    <section className="panel"><div className="panel-title"><div><span className="step">4</span><h2>{t('workflows')}</h2></div><span className="hint">{t('workflowHint')}</span></div>
      <form onSubmit={runOperation}><div className="form-grid"><label>{t('operation')}<select value={operation} onChange={event => setOperation(event.target.value)}>{Object.keys(operationExamples).map(name => <option key={name}>{name}</option>)}</select></label><label className="full-width">{t('operationPayload')}<textarea rows={12} value={operationPayload} onChange={event => setOperationPayload(event.target.value)} /></label></div><button className="primary-action" disabled={busy}>{t('execute')}</button></form>
      <div className="compliance-status-grid"><StatusList title={t('drafts')} items={overview?.operations.drafts ?? []} /><StatusList title={t('reopenRequests')} items={overview?.operations.reopenRequests ?? []} /><StatusList title={t('amendments')} items={overview?.operations.amendments ?? []} /><StatusList title={t('profileAddressMigrations')} items={overview?.operations.profileAddressMigrations ?? []} /><StatusList title={t('retainedArtifacts')} items={overview?.operations.artifacts ?? []} /><StatusList title={t('backups')} items={overview?.operations.backups ?? []} /></div>
      <details><summary>{t('operatorPolicy')}</summary><pre>{JSON.stringify(overview?.operations.policy ?? null, null, 2)}</pre></details>
    </section>
  </div>
}

function Text({ label, value, onChange, required = false, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; type?: string }) { return <label>{label}<input type={type} required={required} value={value} onChange={event => onChange(event.target.value)} /></label> }
function Select({ label, value, values, onChange }: { label: string; value: string; values: string[]; onChange: (value: string) => void }) { return <label>{label}<select value={value} onChange={event => onChange(event.target.value)}>{values.map(item => <option key={item}>{item}</option>)}</select></label> }
function StatusList({ title, items }: { title: string; items: unknown[] }) { return <div><h3>{title}</h3>{items.length ? <pre>{JSON.stringify(items, null, 2)}</pre> : <p>—</p>}</div> }

export function complianceOperationExamples(overview: Overview | null): Record<string, Record<string, unknown>> {
  const periodId = overview?.periods[0]?.id ?? 'period-id'
  const artifactId = overview?.operations.artifacts[0]?.id ?? 'artifact-id'
  const draftId = overview?.operations.drafts[0]?.id ?? 'draft-id'
  const requestId = overview?.operations.reopenRequests[0]?.id ?? 'reopen-request-id'
  const backupId = overview?.operations.backups[0]?.id ?? 'backup-id'
  const historicalProfileId = overview?.operations.profileAddressMigrations?.find(item => !item.confirmed)?.id ?? 'profile-version-id'
  const posting = { fiscalYear: overview?.periods[0]?.referenceYear ?? new Date().getFullYear(), bookingDate: overview?.periods[0]?.startsAt ?? new Date().toISOString().slice(0, 10), documentNumber: 'DOC-1', description: 'Posting', lines: [{ accountId: 'account-id-1', debitCents: 100, creditCents: 0 }, { accountId: 'account-id-2', debitCents: 0, creditCents: 100 }] }
  return {
    'draft.create': { fiscalPeriodId: periodId, posting, reason: 'Prepared for review' },
    'draft.revise': { draftId, expectedVersion: 1, posting, reason: 'Correction before posting' },
    'draft.post': { draftId, reason: 'Approved posting' },
    'entry.correct': { entryId: 'posted-entry-id', replacement: { ...posting, documentNumber: 'DOC-1-CORR' }, reason: 'Incorrect amount' },
    'period.reopen.request': { periodId, reason: 'Required adjustment' },
    'period.reopen.decide': { requestId, approve: true, reason: 'Four-eyes review completed' },
    'filing.amend': { kind: 'E_BILANZ', originalObjectId: 'submission-id', requestPayload: '<amended/>', reason: 'Correction required' },
    'profile.address-confirm': { profileVersionId: historicalProfileId, address: { streetAndHouseNumber: 'Historical street 1', zipCode: '10115', city: 'Berlin', country: 'DE' }, reason: 'Confirmed from historical register evidence' },
    'policy.configure': { allowedStorageRegions: ['local'], operatorIds: [overview?.tenantId ?? 'local'], recoveryPointObjectiveMinutes: 60, recoveryTimeObjectiveMinutes: 120, backupKeyId: 'operator-key-1', reason: 'Initial recovery policy' },
    'retention.hold': { artifactId, until: '2040-12-31', reason: 'Tax audit' },
    'retention.reconcile': { reason: 'Legacy document retention reconciliation' },
    'retention.fixity': { artifactId, reason: 'Scheduled fixity check' },
    'retention.fixity-scan': { before: new Date().toISOString().slice(0, 10), reason: 'Scheduled fixity and readability scan' },
    'retention.dispose': { artifactId, onDate: '2041-01-01', reason: 'Retention and holds expired' },
    'backup.create': { region: 'local', reason: 'Scheduled encrypted backup' },
    'backup.verify-restore': { backupId, measuredRestoreMinutes: 15, reason: 'Disaster recovery exercise' },
  }
}
