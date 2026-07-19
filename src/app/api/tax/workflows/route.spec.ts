import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TaxDeclarationError } from '@/core/taxDeclarations'

const mocks = vi.hoisted(() => ({ user: vi.fn(), list: vi.fn(), submit: vi.fn(), validate: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: mocks.user }))
vi.mock('@/server/tax/workflows', () => ({
  TaxGatewayConfigurationError: class TaxGatewayConfigurationError extends Error {},
  listTaxWorkflows: mocks.list,
  submitTaxDataset: mocks.submit,
  validateTaxDataset: mocks.validate,
}))

import { GET, POST } from './route'

const dataset = { kind: 'USTVA', period: '2026-01', fields: { KZ81: 100, ZAHLLAST: 19 }, drilldown: { KZ81: ['entry-1'] } }
describe('production tax workflow route', () => {
  beforeEach(() => vi.clearAllMocks())

  it('requires authentication and never invokes the filing service anonymously', async () => {
    mocks.user.mockResolvedValue(null)
    expect((await POST(new Request('http://localhost/api/tax/workflows', { method: 'POST', body: '{}' }))).status).toBe(401)
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('lists only the authenticated tenant history', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' }); mocks.list.mockResolvedValue([])
    expect((await GET(new Request('http://localhost/api/tax/workflows'))).status).toBe(200)
    expect(mocks.list).toHaveBeenCalledWith('tenant-a')
  })

  it('requires explicit approval before official submission', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' })
    const response = await POST(jsonRequest({ action: 'submit', requestKey: 'request-key-00001', dataset }))
    expect(response.status).toBe(400)
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('returns 400 for valid JSON that is not a request object', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' })
    expect((await POST(jsonRequest(null))).status).toBe(400)
    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('binds an approved idempotent submission to the authenticated owner and actor', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' }); mocks.submit.mockResolvedValue({ submissionId: 'submission-1', state: 'accepted' })
    const response = await POST(jsonRequest({ action: 'submit', confirmed: true, requestKey: 'request-key-00001', dataset: { ...dataset, taxpayerId: 'tenant-b' } }))
    expect(response.status).toBe(201)
    expect(mocks.submit).toHaveBeenCalledWith('tenant-a', 'tenant-a', 'request-key-00001', dataset)
  })

  it('surfaces official validation errors without transmitting', async () => {
    mocks.user.mockResolvedValue({ id: 'tenant-a' }); mocks.validate.mockRejectedValue(new TaxDeclarationError(['official schema failed']))
    const response = await POST(jsonRequest({ action: 'validate', dataset }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ issues: ['official schema failed'] })
  })
})

function jsonRequest(body: unknown) { return new Request('http://localhost/api/tax/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) }
