import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountingValidationError } from '@/core/doubleEntry'

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), importDatev: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/datevImport', () => ({ importDatev: mocks.importDatev }))
import { POST, readLimitedBody } from './route'

describe('DATEV import API', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires authentication', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    expect((await POST(requestWith())).status).toBe(401)
  })

  it('passes uploaded bytes to the tenant-scoped importer', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1' })
    mocks.importDatev.mockResolvedValue({ imported: 2, skipped: 0 })
    const response = await POST(requestWith(new File(['EXTF;700'], 'bookings.csv', { type: 'text/csv' })))
    expect(response.status).toBe(201)
    expect(mocks.importDatev).toHaveBeenCalledWith('owner-1', [{ name: 'bookings.csv', bytes: expect.any(Uint8Array) }])
  })

  it('returns validation details and rejects an empty upload', async () => {
    mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1' })
    expect((await POST(requestWith())).status).toBe(400)
    mocks.importDatev.mockRejectedValue(new AccountingValidationError(['Ungültige DATEV-Datei.']))
    const response = await POST(requestWith(new File(['bad'], 'bad.csv')))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ issues: ['Ungültige DATEV-Datei.'] })
  })

  it('stops reading a multipart request once the ingress limit is exceeded', async () => {
    const request = new Request('http://localhost/api/datev-import', { method: 'POST', body: '123456' })
    await expect(readLimitedBody(request, 5)).rejects.toThrow(/zu groß/)
  })
})

function requestWith(...files: File[]) {
  const form = new FormData()
  files.forEach(file => form.append('files', file))
  return new Request('http://localhost/api/datev-import', { method: 'POST', body: form })
}
