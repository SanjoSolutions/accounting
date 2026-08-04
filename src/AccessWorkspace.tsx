'use client'

import { useEffect, useState, type FormEvent } from 'react'

type Role = 'ADMIN' | 'ACCOUNTANT' | 'READ_ONLY'
type AccessData = {
  activeTenantId: string
  actorId: string
  role: Role
  members: Array<{ userId: string; email: string; name: string; role: Role; owner: boolean }>
  tenants: Array<{ ownerId: string; role: Role }>
}

export function AccessWorkspace() {
  const [data, setData] = useState<AccessData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const load = async () => {
    const response = await fetch('/api/access')
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? 'Access settings could not be loaded.')
    setData(result.data)
  }
  useEffect(() => { void load().catch(value => setError(value instanceof Error ? value.message : String(value))) }, [])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setError(null); setStatus(null)
    const form = event.currentTarget
    const fields = new FormData(form)
    const response = await fetch('/api/access', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: fields.get('email'), role: fields.get('role'), reason: fields.get('reason') }) })
    const result = await response.json()
    if (!response.ok) { setError(result.error ?? 'Access could not be changed.'); return }
    setStatus('Access saved and recorded in the audit trail.'); form.reset(); await load()
  }

  const selectTenant = async (ownerId: string) => {
    const response = await fetch('/api/access/active-tenant', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerId }) })
    const result = await response.json()
    if (!response.ok) { setError(result.error ?? 'Company could not be selected.'); return }
    window.location.reload()
  }

  return <main>
    <h1>Users and roles</h1>
    {error && <p className="alert alert-danger" role="alert">{error}</p>}
    {status && <p className="alert alert-success" role="status">{status}</p>}
    {!data ? <p role="status">Loading access settings…</p> : <>
      <p>Active company: <code>{data.activeTenantId}</code>. Your role: <strong>{data.role}</strong>.</p>
      <section className="card mb-3"><div className="card-body">
        <h2 className="h4">Companies available to you</h2>
        <ul>{data.tenants.map(tenant => <li key={tenant.ownerId}>{tenant.ownerId} ({tenant.role}) {tenant.ownerId !== data.activeTenantId && <button className="btn btn-sm btn-outline-primary" type="button" onClick={() => void selectTenant(tenant.ownerId)}>Use this company</button>}</li>)}</ul>
      </div></section>
      <section className="card"><div className="card-body">
        <h2 className="h4">Company members</h2>
        <table className="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead><tbody>{data.members.map(member => <tr key={member.userId}><td>{member.name}</td><td>{member.email}</td><td>{member.role}{member.owner ? ' (owner)' : ''}</td></tr>)}</tbody></table>
        {data.role === 'ADMIN' && <form onSubmit={event => void save(event)}>
          <h3 className="h5">Add or change a member</h3>
          <div className="mb-2"><label className="form-label" htmlFor="member-email">Registered user email</label><input className="form-control" id="member-email" name="email" type="email" required /></div>
          <div className="mb-2"><label className="form-label" htmlFor="member-role">Role</label><select className="form-select" id="member-role" name="role" defaultValue="ACCOUNTANT"><option value="ADMIN">Administrator</option><option value="ACCOUNTANT">Accountant</option><option value="READ_ONLY">Read only</option></select></div>
          <div className="mb-2"><label className="form-label" htmlFor="member-reason">Reason</label><input className="form-control" id="member-reason" name="reason" required /></div>
          <button className="btn btn-primary" type="submit">Save access</button>
        </form>}
      </div></section>
    </>}
  </main>
}
