import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  extract: vi.fn(),
  get: vi.fn(),
  confirm: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server/documentExtraction', () => ({
  extractDocumentInvoice: mocks.extract,
  getDocumentExtraction: mocks.get,
  confirmDocumentExtraction: mocks.confirm,
  DocumentExtractionError: class DocumentExtractionError extends Error { constructor(message: string, readonly status: number) { super(message) } },
}))
vi.mock('@/server/authentication', () => ({
  getCurrentUser: mocks.getCurrentUser,
}))

import { GET, PATCH, POST } from './route'

describe('document parsing API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an anonymous parsing request', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null)

    const response = await parse('document-1')

    expect(response.status).toBe(401)
    expect(mocks.extract).not.toHaveBeenCalled()
  })

  it('scopes parsing to the authenticated owner', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1', actorId: 'user-1', role: 'ADMIN' })
    mocks.extract.mockResolvedValueOnce({ id: 'extraction-1', documentId: 'document-1', status: 'NEEDS_REVIEW' })

    const response = await parse('document-1')

    expect(response.status).toBe(200)
    expect(mocks.extract).toHaveBeenCalledWith('user-1', 'document-1', 'user-1')
  })

  it('returns durable extraction state only to the authenticated owner', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1', actorId: 'user-1', role: 'ADMIN' })
    mocks.get.mockResolvedValueOnce({ documentId: 'document-1', status: 'FAILED', failureCode: 'NEEDS_OCR' })
    const response = await GET(new Request('http://localhost/api/documents/document-1/parsing-requests'), { params: Promise.resolve({ id: 'document-1' }) })
    expect(response.status).toBe(200)
    expect(mocks.get).toHaveBeenCalledWith('user-1', 'document-1')
  })

  it('confirms corrected invoice facts as the authenticated reviewer', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1', actorId: 'user-1', role: 'ADMIN' })
    mocks.confirm.mockResolvedValueOnce({ documentId: 'document-1', status: 'CONFIRMED' })
    const data = { supplierName: 'Supplier GmbH', invoiceNumber: 'RE-1', issueDate: '2026-08-04', netAmountCents: 10000, taxAmountCents: 1900, grossAmountCents: 11900 }
    const response = await PATCH(new Request('http://localhost/api/documents/document-1/parsing-requests', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }), { params: Promise.resolve({ id: 'document-1' }) })
    expect(response.status).toBe(200)
    expect(mocks.confirm).toHaveBeenCalledWith('user-1', 'document-1', 'user-1', data)
  })
})

function parse(id: string): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/documents/${ id }/parsing-requests`, { method: 'POST' }),
    { params: Promise.resolve({ id }) },
  )
}
