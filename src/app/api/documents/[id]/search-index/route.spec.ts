import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), index: vi.fn(), error: class extends Error { constructor(message: string, readonly status: number) { super(message) } } }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/documentSearch', () => ({ indexDocumentSearch: mocks.index, DocumentSearchError: mocks.error }))
import { POST } from './route'
const request = () => new Request('http://test/api/documents/a/search-index', { method: 'POST' })
const context = { params: Promise.resolve({ id: 'a' }) }
beforeEach(() => vi.resetAllMocks())

test('Given an anonymous user or a reader, when indexing is requested, then the mutation is denied', async () => {
  mocks.user.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'tenant-a', actorId: 'reader', role: 'VIEWER' })
  expect((await POST(request(), context)).status).toBe(401)
  expect((await POST(request(), context)).status).toBe(403)
  expect(mocks.index).not.toHaveBeenCalled()
})
test('Given a tenant accountant, when indexing a document, then the authenticated tenant scopes the operation', async () => {
  mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'accountant', role: 'ACCOUNTANT' })
  mocks.index.mockResolvedValue({ status: 'READY' })
  expect((await POST(request(), context)).status).toBe(200)
  expect(mocks.index).toHaveBeenCalledWith('tenant-a', 'a')
  mocks.index.mockRejectedValue(new mocks.error('Document not found.', 404))
  expect((await POST(request(), context)).status).toBe(404)
})
