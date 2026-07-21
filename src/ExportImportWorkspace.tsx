"use client"

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

export function ExportImportWorkspace() {
  const t = useTranslations('Workspaces')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [issues, setIssues] = useState<string[]>([])
  const [success, setSuccess] = useState('')
  const formRef = useRef<HTMLFormElement>(null)

  const format = detectSelectedImportFormat(files)

  async function importAccountingData(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setIssues([]); setSuccess('')
    try {
      const form = new FormData(); files.forEach(file => form.append('files', file))
      const response = await fetch('/api/accounting-import', { method: 'POST', body: form })
      const body = await response.json()
      if (!response.ok) { setIssues(body.issues ?? [t('accountingImportFailed')]); return }
      setSuccess(t('accountingImportSucceeded', {
        imported: body.imported, skipped: body.skipped, accounts: body.accounts,
        documents: body.documents ?? 0, years: body.years?.join(', ') ?? '',
      }))
      setFiles([])
      resetDatevForm(formRef.current)
    } catch { setIssues([t('accountingImportFailed')]) }
    finally { setBusy(false) }
  }

  return <div className="workspace py-4">
    <header className="page-heading">
      <div><span className="eyebrow">{t('dataExchange')}</span><h1>{t('exportImport')}</h1><p>{t('exportImportSubtitle')}</p></div>
    </header>
    <section className="card panel datev-panel">
      <div className="panel-title"><div><span className="step">{t('dataImport')}</span><h2>{t('accountingImport')}</h2></div><span className="badge text-bg-light hint">{formatLabel(format)}</span></div>
      <form ref={formRef} onSubmit={importAccountingData}>
        <p>{t('accountingImportHelp')}</p>
        <div className="datev-controls">
          <label>{t('accountingChooseFolder')}<input className="form-control" disabled={busy} type="file" multiple {...{ webkitdirectory: '' }} onChange={event => setFiles(selectAccountingFiles(event.target.files))} /></label>
          <label>{t('datevChooseFiles')}<input className="form-control" disabled={busy} type="file" accept=".csv,text/csv" multiple onChange={event => setFiles(selectDatevFiles(event.target.files))} /></label>
          <button className="btn btn-primary" disabled={busy || files.length === 0 || format === 'UNKNOWN'}>{busy ? t('accountingImportBusy') : t('accountingImportAction')}</button>
        </div>
        {files.length > 0 && <p className="badge text-bg-light hint">{t('accountingFilesSelected', { count: files.length, format: formatLabel(format) })}</p>}
        {issues.length > 0 && <div className="alert alert-danger" role="alert"><strong>{t('pleaseReview')}</strong><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
        {success && <p className="alert alert-success" role="status">{success}</p>}
      </form>
    </section>
  </div>
}

export function selectDatevFiles(files: FileList | ArrayLike<File> | null) {
  return Array.from(files ?? []).filter(file => file.name.toLowerCase().endsWith('.csv'))
}

export type AccountingImportFormat = 'DATEV' | 'LEXWARE_BP' | 'UNKNOWN'

export function selectAccountingFiles(files: FileList | ArrayLike<File> | null) {
  const supported = Array.from(files ?? []).filter(file => /\.(?:csv|txt|xml|dtd|pdf|jpe?g|png|gif|bmp|tiff?|rtf|docx?|xlsx?|odt|ods|odp)$/i.test(file.name))
  return detectSelectedImportFormat(supported) === 'DATEV' ? selectDatevFiles(supported) : supported
}

export function detectSelectedImportFormat(files: ArrayLike<{ name: string }>): AccountingImportFormat {
  const names = Array.from(files).map(file => file.name.toLowerCase())
  const lexware = names.includes('index.xml') && names.some(name => /^jour_bp\d{4}\.txt$/.test(name))
  const datev = names.some(name => name.endsWith('.csv'))
  if (lexware && !datev) return 'LEXWARE_BP'
  if (datev && !lexware) return 'DATEV'
  return 'UNKNOWN'
}

export function formatLabel(format: AccountingImportFormat) {
  if (format === 'DATEV') return 'DATEV EXTF'
  if (format === 'LEXWARE_BP') return 'Lexware Betriebsprüfung'
  return '—'
}

export function resetDatevForm(form: Pick<HTMLFormElement, 'reset'> | null) { form?.reset() }
