import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: {} }))
import { officialGatewayConfigurationId, TaxGatewayConfigurationError, prepareTenantDataset, validateTaxDataset } from './workflows'

describe('official tax production adapter boundary', () => {
  it('derives a restart-stable identity from the configured official authority', () => {
    expect(officialGatewayConfigurationId('https://authority.example', false)).toBe(officialGatewayConfigurationId('https://authority.example', false))
    expect(officialGatewayConfigurationId('https://other.example', false)).not.toBe(officialGatewayConfigurationId('https://authority.example', false))
    expect(officialGatewayConfigurationId('https://authority.example', false, 'rotated-credential-b')).not.toBe(officialGatewayConfigurationId('https://authority.example', false, 'rotated-credential-a'))
    expect(officialGatewayConfigurationId('https://authority.example', false, 'rotated-credential-a')).not.toContain('rotated-credential-a')
  })
  it('binds every prepared dataset to the authenticated tenant identity', () => {
    const dataset = prepareTenantDataset('tenant-a', { kind: 'USTVA', period: '2026-01', fields: { ZAHLLAST: 0 }, drilldown: {} })
    expect(dataset.taxpayerId).toBe('tenant-a')
  })
  it('fails closed when the official gateway has not been configured', async () => {
    delete process.env.TAX_GATEWAY_URL; delete process.env.TAX_GATEWAY_CREDENTIAL
    await expect(validateTaxDataset('tenant-a', { kind: 'USTVA', period: '2026-01', fields: { ZAHLLAST: 0 }, drilldown: {} })).rejects.toBeInstanceOf(TaxGatewayConfigurationError)
  })
})
