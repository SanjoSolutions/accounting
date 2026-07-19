import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createDocument: vi.fn(),
  getCurrentUser: vi.fn(),
  getMaxDocumentUploadBytes: vi.fn(() => 1024),
  listDocuments: vi.fn(),
  parseStructuredUpload: vi.fn((): unknown => null),
  storeStructuredInvoice: vi.fn(),
  conflict: class StructuredInvoiceConflictError extends Error {},
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server', () => ({
  createDocument: mocks.createDocument,
  DocumentUploadError: class DocumentUploadError extends Error {},
  getMaxDocumentUploadBytes: mocks.getMaxDocumentUploadBytes,
  listDocuments: mocks.listDocuments,
}))
vi.mock('@/server/authentication', () => ({
  getCurrentUser: mocks.getCurrentUser,
}))
vi.mock('@/server/tax/structuredInvoices', () => ({
  parseStructuredUpload: mocks.parseStructuredUpload,
  storeStructuredInvoice: mocks.storeStructuredInvoice,
  StructuredInvoiceConflictError: mocks.conflict,
}))

import { GET, POST } from './route'

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

  it('lists only the authenticated owner documents', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1' })
    mocks.listDocuments.mockResolvedValueOnce([{ id: 'document-1', fileName: 'invoice.pdf' }])

    const response = await GET(new Request('http://localhost/api/documents'))

    expect(response.status).toBe(200)
    expect(mocks.listDocuments).toHaveBeenCalledWith('user-1')
    expect(await response.json()).toMatchObject({ data: [{ id: 'document-1' }] })
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

  it('preserves a validated structured original for the authenticated tenant', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1' })
    mocks.parseStructuredUpload.mockReturnValueOnce({ data: { invoiceNumber: 'INV-1' } })
    mocks.storeStructuredInvoice.mockResolvedValueOnce({ id: 'structured-1', documentId: 'document-1' })
    const request = new Request('http://localhost/api/documents', { method: 'POST', headers: { 'content-type': 'application/xml', 'x-document-file-name': 'invoice.xml' }, body: '<Invoice />' })

    const response = await POST(request)

    expect(response.status).toBe(201)
    expect(mocks.storeStructuredInvoice).toHaveBeenCalledWith('user-1', expect.anything(), 'invoice.xml')
    expect(mocks.createDocument).not.toHaveBeenCalled()
  })

  it('keeps an unrecognized XML document on the generic document path', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1' })
    mocks.createDocument.mockResolvedValueOnce({ id: 'document-xml' })
    const request = new Request('http://localhost/api/documents', { method: 'POST', headers: { 'content-type': 'application/xml', 'x-document-file-name': 'report.xml' }, body: '<Report />' })

    const response = await POST(request)

    expect(response.status).toBe(201)
    expect(mocks.createDocument).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'report.xml', contentType: 'application/xml' }), 'user-1')
    expect(mocks.storeStructuredInvoice).not.toHaveBeenCalled()
  })

  it('returns a deterministic conflict when the structured invoice already exists', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1' })
    mocks.parseStructuredUpload.mockReturnValueOnce({ data: { invoiceNumber: 'INV-1' } })
    mocks.storeStructuredInvoice.mockRejectedValueOnce(new mocks.conflict('duplicate'))
    const request = new Request('http://localhost/api/documents', { method: 'POST', headers: { 'content-type': 'application/xml', 'x-document-file-name': 'invoice.xml' }, body: '<Invoice />' })

    const response = await POST(request)

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ success: false, error: 'duplicate' })
    expect(mocks.createDocument).not.toHaveBeenCalled()
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
