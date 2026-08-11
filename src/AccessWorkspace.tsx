'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'

type Role = 'ADMIN' | 'ACCOUNTANT' | 'READ_ONLY'
type AccessData = {
  activeTenantId: string
  actorId: string
  role: Role
  members: Array<{ userId: string; email: string; name: string; role: Role; owner: boolean }>
  tenants: Array<{ ownerId: string; role: Role }>
}

export function AccessWorkspace() {
  const t = useTranslations('Access')
  const [data, setData] = useState<AccessData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = async () => {
    const response = await fetch('/api/access')
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? t('loadFailed'))
    setData(result.data)
  }
  useEffect(() => { void load().catch(value => setError(value instanceof Error ? value.message : String(value))) }, [])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(null); setStatus(null)
    const form = event.currentTarget
    const fields = new FormData(form)
    const response = await fetch('/api/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: fields.get('email'), role: fields.get('role'), reason: fields.get('reason') }) })
    const result = await response.json()
    if (!response.ok) { setError(result.error ?? t('saveFailed')); return }
    setStatus(t('saved')); form.reset(); await load()
  }

  const selectTenant = async (ownerId: string) => {
    const response = await fetch('/api/access/active-tenant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerId }) })
    const result = await response.json()
    if (!response.ok) { setError(result.error ?? t('companySelectFailed')); return }
    window.location.reload()
  }

  return <main>
    <h1>{t('title')}</h1>
    {error && <p className="alert alert-danger" role="alert">{error}</p>}
    {status && <p className="alert alert-success" role="status">{status}</p>}
    {!data ? <p role="status">{t('loading')}</p> : <>
      <p>{t('activeCompany')} <code>{data.activeTenantId}</code>. {t('yourRole')} <strong>{t(`roles.${data.role}`)}</strong>.</p>
      <section className="card mb-3"><div className="card-body">
        <h2 className="h4">{t('availableCompanies')}</h2>
        <ul>{data.tenants.map(tenant => <li key={tenant.ownerId}>{tenant.ownerId} ({t(`roles.${tenant.role}`)}) {tenant.ownerId !== data.activeTenantId && <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => void selectTenant(tenant.ownerId)}>{t('useCompany')}</button>}</li>)}</ul>
      </div></section>
      <section className="card"><div className="card-body">
        <h2 className="h4">{t('members')}</h2>
        <table className="table"><thead><tr><th>{t('name')}</th><th>{t('email')}</th><th>{t('role')}</th></tr></thead><tbody>{data.members.map(member => <tr key={member.userId}><td>{member.name}</td><td>{member.email}</td><td>{t(`roles.${member.role}`)}{member.owner ? ` (${t('owner')})` : ''}</td></tr>)}</tbody></table>
        {data.role === 'ADMIN' && <form onSubmit={event => void save(event)}>
          <h3 className="h5">{t('addMember')}</h3>
          <div className="mb-2"><label className="form-label" htmlFor="member-email">{t('registeredEmail')}</label><input className="form-control" id="member-email" name="email" type="email" required /></div>
          <div className="mb-2"><label className="form-label" htmlFor="member-role">{t('role')}</label><select className="form-select" id="member-role" name="role" defaultValue="ACCOUNTANT"><option value="ADMIN">{t('roles.ADMIN')}</option><option value="ACCOUNTANT">{t('roles.ACCOUNTANT')}</option><option value="READ_ONLY">{t('roles.READ_ONLY')}</option></select></div>
          <div className="mb-2"><label className="form-label" htmlFor="member-reason">{t('reason')}</label><input className="form-control" id="member-reason" name="reason" required /></div>
          <button className="btn btn-primary" type="submit">{t('save')}</button>
        </form>}
      </div></section>
    </>}
  </main>
}
