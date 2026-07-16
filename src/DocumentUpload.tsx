import React, { useCallback, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import type { Document as AccountingDocument } from './core/Document'
import { api, getJSON } from './Requester'

export function DocumentUpload({
  onDocumentUploaded,
}: {
  onDocumentUploaded: (document: AccountingDocument) => void
}) {
  const t = useTranslations('DocumentUpload')
  const fileInput = useRef<HTMLInputElement>(null)
  const [isUploading, setIsUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      const file = fileInput.current?.files?.item(0)
      if (!file) return

      setIsUploading(true)
      setError(null)

      try {
        const uploadResponse = await api.postFile('/api/documents', file)
        const uploadResult = await getJSON(uploadResponse)
        if (!uploadResponse.ok) {
          throw new Error(uploadResult.error || 'Document upload failed')
        }

        const parsingResponse = await api.post(
          `/api/documents/${ uploadResult.data.id }/parsing-requests`,
          {},
        )
        const parsingResult = await getJSON(parsingResponse)
        if (!parsingResponse.ok) throw new Error('Document parsing failed')

        onDocumentUploaded(parsingResult.data)
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : 'Document upload failed')
      } finally {
        setIsUploading(false)
      }
    },
    [onDocumentUploaded],
  )

  return (
    <form onSubmit={ onSubmit }>
      <div className="mb-3">
        <label htmlFor="file" className="form-label">{ t('Document') }</label>
        <input
          ref={ fileInput }
          className="form-control form-control-lg"
          id="file"
          type="file"
          accept="application/pdf,.pdf"
          required
          disabled={ isUploading }
        />
      </div>

      { error ? <div className="alert alert-danger" role="alert">{ error }</div> : null }

      <div className="text-end">
        <button type="submit" className="btn btn-primary btn-lg" disabled={ isUploading }>
          { isUploading ? `${ t('Upload') }…` : t('Upload') }
        </button>
      </div>
    </form>
  )
}
