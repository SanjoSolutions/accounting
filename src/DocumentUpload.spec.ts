import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { documentUploadErrorKey } from './DocumentUpload'

describe('document upload copy boundary', () => {
  test('maps upload and parsing failures to localized fallback keys without exposing API text', () => {
    expect(documentUploadErrorKey('upload')).toBe('uploadFailed')
    expect(documentUploadErrorKey('parsing')).toBe('parsingFailed')

    const messages = JSON.parse(readFileSync('messages/en.json', 'utf8')) as { DocumentUpload: Record<string, string> }
    expect(messages.DocumentUpload.uploadFailed).toBe('The document could not be uploaded.')
    expect(messages.DocumentUpload.parsingFailed).toBe('The document could not be parsed.')
  })
})
