import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createDocument: vi.fn(),
  getCurrentUser: vi.fn(),
  getMaxDocumentUploadBytes: vi.fn(() => 1024),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server', () => ({
  createDocument: mocks.createDocument,
  DocumentUploadError: class DocumentUploadError extends Error {},
  getMaxDocumentUploadBytes: mocks.getMaxDocumentUploadBytes,
}))
vi.mock('@/server/authentication', () => ({
  getCurrentUser: mocks.getCurrentUser,
}))

import { POST } from './route'

describe('document upload API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMaxDocumentUploadBytes.mockReturnValue(1024)
  })

  it('rejects an anonymous upload', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null)

    const response = await POST(createUploadRequest('%PDF-test'))

    expect(response.status).toBe(401)
    expect(mocks.createDocument).not.toHaveBeenCalled()
  })

  it('streams the document to the authenticated owner', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1' })
    mocks.createDocument.mockResolvedValueOnce({ id: 'document-1' })

    const response = await POST(createUploadRequest('%PDF-test', 'invoice 1.pdf'))

    expect(response.status).toBe(201)
    expect(mocks.createDocument).toHaveBeenCalledWith({
      content: Buffer.from('%PDF-test'),
      contentType: 'application/pdf',
      fileName: 'invoice 1.pdf',
    }, 'user-1')
  })

  it('stops reading a body that exceeds the configured limit', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1' })
    mocks.getMaxDocumentUploadBytes.mockReturnValueOnce(5)

    const response = await POST(createUploadRequest('%PDF-test'))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ success: false })
    expect(mocks.createDocument).not.toHaveBeenCalled()
  })
})

function createUploadRequest(content: string, fileName = 'invoice.pdf'): Request {
  return new Request('http://localhost/api/documents', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
      'X-Document-File-Name': encodeURIComponent(fileName),
    },
    body: content,
  })
}
