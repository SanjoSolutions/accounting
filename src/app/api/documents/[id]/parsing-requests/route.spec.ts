import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  requestDocumentParsing: vi.fn(),
}))

vi.mock('server-only', () => ({}))
vi.mock('@/server', () => ({
  requestDocumentParsing: mocks.requestDocumentParsing,
}))
vi.mock('@/server/authentication', () => ({
  getCurrentUser: mocks.getCurrentUser,
}))

import { POST } from './route'

describe('document parsing API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an anonymous parsing request', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce(null)

    const response = await parse('document-1')

    expect(response.status).toBe(401)
    expect(mocks.requestDocumentParsing).not.toHaveBeenCalled()
  })

  it('scopes parsing to the authenticated owner', async () => {
    mocks.getCurrentUser.mockResolvedValueOnce({ id: 'user-1' })
    mocks.requestDocumentParsing.mockResolvedValueOnce({ id: 'document-1' })

    const response = await parse('document-1')

    expect(response.status).toBe(200)
    expect(mocks.requestDocumentParsing).toHaveBeenCalledWith('document-1', 'user-1')
  })
})

function parse(id: string): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/documents/${ id }/parsing-requests`, { method: 'POST' }),
    { params: Promise.resolve({ id }) },
  )
}
