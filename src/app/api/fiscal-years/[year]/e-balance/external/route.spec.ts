import { beforeEach, describe, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ user: vi.fn(), overview: vi.fn(), create: vi.fn(), download: vi.fn(), attachEvidence: vi.fn(), downloadEvidence: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/externalEBalance/runtime', () => ({ externalEBalance: mocks }))
import { GET, POST } from './route'
import { GET as DOWNLOAD } from './[id]/route'
import { POST as ATTACH, GET as EVIDENCE } from './[id]/evidence/route'

const context = { params: Promise.resolve({ year: '2026', id: 'package-1' }) }
const request = (method = 'GET', suffix = '') => new Request(`http://127.0.0.1:3112/api/fiscal-years/2026/e-balance/external${suffix}`, { method })
beforeEach(() => { vi.clearAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'actor-b', role: 'ADMIN' }); mocks.overview.mockResolvedValue({ ready: true, packages: [], issues: [] }); mocks.create.mockResolvedValue({ id: 'package-1', version: 1 }); mocks.download.mockResolvedValue({ content: new Uint8Array([80, 75]), contentHash: 'a'.repeat(64), packageHash: 'b'.repeat(64), fileName: 'export.zip', sourceStatus: 'CURRENT' }) })
describe('External E-Bilanz authenticated API', () => {
  test('Given no session, when any external boundary is called, then it rejects before repository access', async () => {
    mocks.user.mockResolvedValue(null)
    for (const [handler, method] of [[GET, 'GET'], [POST, 'POST'], [DOWNLOAD, 'GET'], [ATTACH, 'POST'], [EVIDENCE, 'GET']] as const) expect((await handler(request(method), context)).status).toBe(401)
    expect(mocks.overview).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.attachEvidence).not.toHaveBeenCalled()
  })
  test('Given a read-only actor, when creating or attaching, then writes are forbidden while retained downloads remain available', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a', actorId: 'reader', role: 'READ_ONLY' })
    expect((await POST(request('POST'), context)).status).toBe(403)
    expect((await ATTACH(request('POST'), context)).status).toBe(403)
    expect((await DOWNLOAD(request(), context)).status).toBe(200)
    expect(await (await GET(request(), context)).json()).toMatchObject({ canWrite: false })
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.attachEvidence).not.toHaveBeenCalled()
  })
  test('Given an authorized actor, when creating and downloading, then only session tenant and actual actor reach retention', async () => {
    expect((await POST(request('POST', '?tenantId=attacker'), context)).status).toBe(201)
    expect(mocks.create).toHaveBeenCalledWith('tenant-a', 'actor-b', 2026)
    const response = await DOWNLOAD(request('GET', '/package-1?file=susa.csv&tenantId=attacker'), context)
    expect(mocks.download).toHaveBeenCalledWith('tenant-a', 'actor-b', 2026, 'package-1', 'susa.csv')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
  })
  test('Given a preview request, when retrieving retained text, then JSON transports it as inert text', async () => {
    mocks.download.mockResolvedValueOnce({ content: new TextEncoder().encode('<script>alert(1)</script>'), contentHash: 'a'.repeat(64), packageHash: 'b'.repeat(64), sourceStatus: 'STALE' })
    const response = await DOWNLOAD(request('GET', '/package-1?preview=e-bilanz.xbrl'), context)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(await response.json()).toMatchObject({ text: '<script>alert(1)</script>', sourceStatus: 'STALE' })
  })
  test('Given a cross-origin request, when preparing, then no package is created', async () => {
    const response = await POST(new Request('http://127.0.0.1:3112/api', { method: 'POST', headers: { origin: 'https://foreign.test' } }), context)
    expect(response.status).toBe(403); expect(mocks.create).not.toHaveBeenCalled()
  })
})
