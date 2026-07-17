import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  readDocumentThumbnail: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server', () => ({ readDocumentThumbnail: mocks.readDocumentThumbnail }))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))

import { GET } from './route'

describe('document thumbnail API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects an anonymous thumbnail request', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null)

    const response = await thumbnail('document-1')

    expect(response.status).toBe(401)
    expect(mocks.readDocumentThumbnail).not.toHaveBeenCalled()
  })

  it('returns the stored thumbnail only to the document owner', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1' })
    mocks.readDocumentThumbnail.mockResolvedValueOnce({
      content: Buffer.from('webp-thumbnail'),
      contentType: 'image/webp',
    })

    const response = await thumbnail('document-1')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/webp')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mocks.readDocumentThumbnail).toHaveBeenCalledWith('document-1', 'user-1')
  })

  it('does not reveal another owner thumbnail', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-2' })
    mocks.readDocumentThumbnail.mockResolvedValueOnce(null)

    expect((await thumbnail('document-1')).status).toBe(404)
  })
})

function thumbnail(id: string): Promise<Response> {
  return GET(
    new Request(`http://localhost/api/documents/${ id }/thumbnail`),
    { params: Promise.resolve({ id }) },
  )
}
