import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  readDocumentFile: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server', () => ({ readDocumentFile: mocks.readDocumentFile }))
vi.mock('@/server/authentication', () => ({
  getCurrentUser: mocks.getCurrentUser,
}))

import { GET } from './route'

describe('document download API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an anonymous download', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null)

    const response = await download('document-1')

    expect(response.status).toBe(401)
    expect(mocks.readDocumentFile).not.toHaveBeenCalled()
  })

  it('loads a document only for the authenticated owner', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1' })
    mocks.readDocumentFile.mockResolvedValueOnce({
      content: Buffer.from('%PDF-test'),
      contentType: 'application/pdf',
      fileName: 'invoice.pdf',
    })

    const response = await download('document-1')

    expect(response.status).toBe(200)
    expect(mocks.readDocumentFile).toHaveBeenCalledWith('document-1', 'user-1')
    expect(response.headers.get('content-disposition')).toBe('inline; filename="document-1.pdf"')
  })

  it('forces active evidence formats to download instead of rendering inline', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1' })
    mocks.readDocumentFile.mockResolvedValueOnce({
      content: Buffer.from('<invoice/>'), contentType: 'application/xml', fileName: 'invoice.xml',
    })

    const response = await download('document-1')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="document-1.xml"')
  })

  it('does not reveal a document outside the owner scope', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-2' })
    mocks.readDocumentFile.mockResolvedValueOnce(null)

    const response = await download('document-1')

    expect(response.status).toBe(404)
    expect(mocks.readDocumentFile).toHaveBeenCalledWith('document-1', 'user-2')
  })
})

function download(id: string): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/documents/${ id }/file`),
    { params: Promise.resolve({ id }) },
  )
}
