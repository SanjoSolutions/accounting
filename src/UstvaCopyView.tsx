import { useState } from 'react'
import { formatUstvaCopyValue, ustvaCopyFieldValue, ustvaCopyPages } from './core/ustvaCopy'

export interface UstvaCopyContext {
  companyName: string
  taxNumber: string
  taxOffice: string
  filingFrequency: string
  registeredAddress?: { streetAndHouseNumber: string; zipCode: string; city: string; country: string }
}

export function UstvaCopyView({ period, fields, context, labels }: {
  period: string
  fields: Readonly<Record<string, number | string | boolean>>
  context: UstvaCopyContext | null
  labels: { title: string; description: string; page: string; section: string; code: string; value: string; copy: string; copied: string; wholeEuros: string; eurosAndCents: string; leaveEmpty: string; identity: string; period: string; unsupported: string }
}) {
  const [copied, setCopied] = useState('')
  async function copy(key: string, value: string) { await navigator.clipboard.writeText(value); setCopied(key) }
  return <section className="card panel mt-4" aria-labelledby="ustva-copy-title">
    <h2 id="ustva-copy-title">{labels.title}</h2><p className="text-body-secondary">{labels.description}</p><div className="alert alert-warning">{labels.unsupported}</div>
    <div className="card bg-light border-0 mb-3"><div className="card-body"><h3 className="h6">{labels.identity}</h3><dl className="row mb-0">
      <dt className="col-sm-3">{labels.period}</dt><dd className="col-sm-9"><code>{period}</code></dd><dt className="col-sm-3">Steuernummer</dt><dd className="col-sm-9">{context?.taxNumber || labels.leaveEmpty}</dd><dt className="col-sm-3">Finanzamt</dt><dd className="col-sm-9">{context?.taxOffice || labels.leaveEmpty}</dd><dt className="col-sm-3">Unternehmer</dt><dd className="col-sm-9">{context?.companyName || labels.leaveEmpty}</dd><dt className="col-sm-3">Anschrift</dt><dd className="col-sm-9">{context?.registeredAddress ? `${context.registeredAddress.streetAndHouseNumber}, ${context.registeredAddress.zipCode} ${context.registeredAddress.city}, ${context.registeredAddress.country}` : labels.leaveEmpty}</dd>
    </dl></div></div>
    <div className="d-grid gap-3">{ustvaCopyPages.map(({ page, fields: pageFields }) => <section className="card" key={page} aria-labelledby={`ustva-page-${page}`}>
      <h3 className="card-header h6 mb-0" id={`ustva-page-${page}`}>{labels.page} {page}</h3>
      <div className="table-responsive m-0"><table className="table table-hover align-middle mb-0">
        <thead><tr><th>{labels.section}</th><th>{labels.code}</th><th>ELSTER</th><th>{labels.value}</th><th><span className="visually-hidden">{labels.copy}</span></th></tr></thead><tbody>{pageFields.map(field => { const present = typeof fields[field.key] === 'number'; const value = ustvaCopyFieldValue(fields, field); return <tr key={field.key} className={present ? '' : 'text-body-secondary'}><td>{field.section}</td><th scope="row"><span className="badge text-bg-secondary">{field.code}</span></th><td>{field.label}<div className="small text-body-secondary">{field.unit === 'whole-euros' ? labels.wholeEuros : labels.eurosAndCents}</div></td><td><code className="fs-6">{present ? value : labels.leaveEmpty}</code></td><td>{present && <button type="button" className="btn btn-sm btn-outline-secondary" onClick={() => void copy(field.key, value)}>{copied === field.key ? labels.copied : labels.copy}</button>}</td></tr> })}</tbody>
      </table></div>
    </section>)}</div>
    {typeof fields.ZAHLLAST === 'number' && <p className="small text-body-secondary mt-3 mb-0">Zahllast (interner Kontrollwert): {formatUstvaCopyValue(fields.ZAHLLAST, 'euros-and-cents')} EUR</p>}
  </section>
}
