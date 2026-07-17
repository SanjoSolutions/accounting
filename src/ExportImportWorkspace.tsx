"use client"

import { useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

export function ExportImportWorkspace() {
  const t = useTranslations('Workspaces')
  const [datevFiles, setDatevFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [issues, setIssues] = useState<string[]>([])
  const [success, setSuccess] = useState('')
  const formRef = useRef<HTMLFormElement>(null)

  async function importDatev(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setIssues([]); setSuccess('')
    try {
      const form = new FormData(); datevFiles.forEach(file => form.append('files', file))
      const response = await fetch('/api/datev-import', { method: 'POST', body: form })
      const body = await response.json()
      if (!response.ok) { setIssues(body.issues ?? [t('datevImportFailed')]); return }
      setSuccess(t('datevImportSucceeded', { imported: body.imported, skipped: body.skipped, accounts: body.accounts }))
      setDatevFiles([])
      resetDatevForm(formRef.current)
    } catch { setIssues([t('datevImportFailed')]) }
    finally { setBusy(false) }
  }

  return <div className="workspace py-4">
    <header className="page-heading">
      <div><span className="eyebrow">{t('dataExchange')}</span><h1>{t('exportImport')}</h1><p>{t('exportImportSubtitle')}</p></div>
    </header>
    <section className="panel datev-panel">
      <div className="panel-title"><div><span className="step">{t('dataImport')}</span><h2>{t('datevImport')}</h2></div><span className="hint">DATEV EXTF</span></div>
      <form ref={formRef} onSubmit={importDatev}>
        <p>{t('datevImportHelp')}</p>
        <div className="datev-controls">
          <label>{t('datevChooseFiles')}<input disabled={busy} type="file" accept=".csv,text/csv" multiple onChange={event => setDatevFiles(selectDatevFiles(event.target.files))} /></label>
          <label>{t('datevChooseFolder')}<input disabled={busy} type="file" multiple {...{ webkitdirectory: '' }} onChange={event => setDatevFiles(selectDatevFiles(event.target.files))} /></label>
          <button className="primary-action" disabled={busy || datevFiles.length === 0}>{busy ? t('datevImportBusy') : t('datevImportAction')}</button>
        </div>
        {datevFiles.length > 0 && <p className="hint">{t('datevFilesSelected', { count: datevFiles.length })}</p>}
        {issues.length > 0 && <div className="error-summary" role="alert"><strong>{t('pleaseReview')}</strong><ul>{issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div>}
        {success && <p className="success" role="status">{success}</p>}
      </form>
    </section>
  </div>
}

export function selectDatevFiles(files: FileList | ArrayLike<File> | null) {
  return Array.from(files ?? []).filter(file => file.name.toLowerCase().endsWith('.csv'))
}

export function resetDatevForm(form: Pick<HTMLFormElement, 'reset'> | null) { form?.reset() }
