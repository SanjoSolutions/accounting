import { beforeEach, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), search: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/documentSearch', () => ({ searchDocuments: mocks.search }))
import { GET } from './route'
beforeEach(() => vi.resetAllMocks())

test('Given an anonymous caller, when searching, then no document query runs', async () => {
  mocks.user.mockResolvedValue(null)
  expect((await GET(new Request('http://test/api/documents/search?q=invoice'))).status).toBe(401)
  expect(mocks.search).not.toHaveBeenCalled()
})
test('Given a delegated tenant reader, when searching, then owner input is ignored and results are not cached', async () => {
  mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'reader', role: 'VIEWER' })
  mocks.search.mockResolvedValue({ documents: [] })
  const response = await GET(new Request('http://test/api/documents/search?q=Office&ownerId=tenant-b&offset=50&scope=all'))
  expect(mocks.search).toHaveBeenCalledWith('tenant-a', 'Office', 50, 'all')
  expect(response.headers.get('Cache-Control')).toBe('private, no-store')
})
test('Given an invalid query, when validation fails, then the API returns a controlled client error', async () => {
  mocks.user.mockResolvedValue({ id: 'tenant-a' })
  mocks.search.mockRejectedValue(new RangeError('Invalid query'))
  expect((await GET(new Request('http://test/api/documents/search'))).status).toBe(400)
  expect((await GET(new Request('http://test/api/documents/search?scope=secret'))).status).toBe(400)
})
