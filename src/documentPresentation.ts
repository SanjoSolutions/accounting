type DocumentMetadata = { contentType?: string; fileName?: string }

/** Prefer normalized MIME metadata; legacy records may only have a filename. */
export function documentIconClass(document: DocumentMetadata): string {
  const contentType = document.contentType?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType === 'application/pdf') return 'bi bi-file-earmark-pdf'
  if (contentType === 'application/xml' || contentType === 'text/xml' || contentType?.endsWith('+xml')) return 'bi bi-file-earmark-code'

  const extension = document.fileName?.trim().match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase()
  if (extension === 'pdf') return 'bi bi-file-earmark-pdf'
  if (extension === 'xml') return 'bi bi-file-earmark-code'
  return 'bi bi-file-earmark'
}

export function documentDisplayName(fileName: string, fallbackName = fileName): string {
  return fileName.replace(/\.(?:pdf|xml)$/i, '') || fallbackName
}
