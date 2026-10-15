import { beforeEach, describe, expect, test, vi } from 'vitest'
import { EuerValidationError } from '@/core/euer'
const mocks = vi.hoisted(() => ({ user: vi.fn(), get: vi.fn(), save: vi.fn(), export: vi.fn() }))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/euerRepository', () => ({ getEuerWorkspace: mocks.get, saveEuerRevision: mocks.save, exportEuer: mocks.export, EuerConflictError: class extends Error {} }))
import { EuerConflictError } from '@/server/tax/euerRepository'
import { GET, POST } from './route'
const post = (body: unknown) => new Request('http://127.0.0.1:3227/api/tax/euer', { method: 'POST', body: JSON.stringify(body) })

describe('EÜR routes', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.user.mockResolvedValue({ id: 'tenant', actorId: 'accountant', role: 'ACCOUNTANT' }) })
  test('Given an authenticated accountant, when reading and writing, then the server supplies tenant and actor identity', async () => {
    mocks.get.mockResolvedValue({ version: 0 }); mocks.save.mockResolvedValue({ version: 1 })
    expect((await GET(new Request('http://127.0.0.1:3227/api/tax/euer?year=2026&ownerId=other'))).status).toBe(200)
    expect(mocks.get).toHaveBeenCalledWith('tenant', 2026)
    const body = { ownerId: 'other', actorId: 'other', year: 2026 }
    expect((await POST(post(body))).status).toBe(200)
    expect(mocks.save).toHaveBeenCalledWith('tenant', 'accountant', body)
  })
  test('Given an anonymous or read-only user, when saving, then no revision is written', async () => {
    mocks.user.mockResolvedValue(null)
    expect((await GET(new Request('http://127.0.0.1:3227/api/tax/euer?year=2026'))).status).toBe(401)
    expect((await POST(post({}))).status).toBe(401)
    mocks.user.mockResolvedValue({ id: 'tenant', actorId: 'reader', role: 'READ_ONLY' })
    expect((await POST(post({}))).status).toBe(403)
    expect(mocks.save).not.toHaveBeenCalled()
  })
  test('Given invalid input or a stale save, when rejected, then a client error is returned without submission', async () => {
    mocks.save.mockRejectedValueOnce(new EuerValidationError(['Invalid entry']))
    expect((await POST(post({}))).status).toBe(400)
    mocks.save.mockRejectedValueOnce(new EuerConflictError('Stale'))
    expect((await POST(post({}))).status).toBe(409)
    expect((await GET(new Request('http://127.0.0.1:3227/api/tax/euer?year=2027'))).status).toBe(400)
    expect((await POST(new Request('http://127.0.0.1:3227/api/tax/euer', { method: 'POST', body: '{' }))).status).toBe(400)
  })
  test('Given a saved version, when downloading, then only that tenant workpaper is returned as a noncached CSV attachment', async () => {
    mocks.export.mockResolvedValue('CSV')
    const response = await GET(new Request('http://127.0.0.1:3227/api/tax/euer?year=2026&format=csv&version=3'))
    expect(mocks.export).toHaveBeenCalledWith('tenant', 2026, 3)
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="euer-2026.csv"')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('CSV')
  })
})
