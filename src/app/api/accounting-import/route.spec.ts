import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getCurrentUser: vi.fn(), importDatev: vi.fn(), importLexwareAudit: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.getCurrentUser }))
vi.mock('@/server/datevImport', () => ({ importDatev: mocks.importDatev }))
vi.mock('@/server/lexwareAuditImport', () => ({ importLexwareAudit: mocks.importLexwareAudit }))
import { POST } from './route'

describe('auto-detected accounting import API', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.getCurrentUser.mockResolvedValue({ id: 'owner-1' }) })

  it('requires authentication', async () => {
    mocks.getCurrentUser.mockResolvedValue(null)
    expect((await POST(requestWith(new File(['x'], 'index.xml')))).status).toBe(401)
  })

  it('detects a Lexware Betriebsprüfung folder', async () => {
    mocks.importLexwareAudit.mockResolvedValue({ format: 'LEXWARE_BP', imported: 2 })
    const response = await POST(requestWith(
      new File(['<?xml version="1.0"?><DataSet/>'], 'index.xml'),
      new File(['header'], 'jour_bp2025.txt'),
    ))
    expect(response.status).toBe(201)
    expect(mocks.importLexwareAudit).toHaveBeenCalledWith('owner-1', expect.arrayContaining([
      expect.objectContaining({ name: 'index.xml', bytes: expect.any(Uint8Array) }),
    ]))
    expect(mocks.importDatev).not.toHaveBeenCalled()
  })

  it('detects DATEV CSV input and rejects unknown or mixed folders', async () => {
    mocks.importDatev.mockResolvedValue({ imported: 1, skipped: 0, accounts: 2, years: [2024] })
    const datevResponse = await POST(requestWith(new File(['EXTF'], 'bookings.csv')))
    expect(datevResponse.status).toBe(201)
    expect(await datevResponse.json()).toMatchObject({ format: 'DATEV', documents: 0, years: [2024] })
    expect(mocks.importDatev).toHaveBeenCalled()
    expect((await POST(requestWith(new File(['x'], 'readme.txt')))).status).toBe(400)
    expect((await POST(requestWith(
      new File(['x'], 'index.xml'), new File(['x'], 'jour_bp2025.txt'), new File(['x'], 'bookings.csv'),
    ))).status).toBe(400)
  })

  it('rejects a request above the safe buffered ingress limit before reading its body', async () => {
    const response = await POST(new Request('http://localhost/api/accounting-import', {
      method: 'POST',
      body: new FormData(),
      headers: { 'content-length': String(67 * 1024 * 1024) },
    }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ issues: ['Der Importordner ist zu groß.'] })
  })
})

function requestWith(...files: File[]) {
  const form = new FormData()
  files.forEach(file => form.append('files', file))
  return new Request('http://localhost/api/accounting-import', { method: 'POST', body: form })
}
