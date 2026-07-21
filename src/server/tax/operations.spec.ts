import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: {} }))
import { assertProductionGatewayReady, evaluateTaxReadiness, gatewayOperationalEvent, invoiceSequenceReadinessIssues, productionGatewayIssues } from './operations'

const qualified = {
  TAX_GATEWAY_URL: 'https://gateway.example/api', TAX_GATEWAY_CREDENTIAL: 'test-only-gateway-material',
  ANNUAL_TAX_CALCULATOR_URL: 'https://calculator.example/api', ANNUAL_TAX_CALCULATOR_CREDENTIAL: 'test-only-calculator-material',
  TAX_PRODUCTION_FILING_ENABLED: 'true', TAX_GATEWAY_QUALIFICATION_ID: 'qualification-2026-07-21',
  TAX_GATEWAY_QUALIFIED_FORM_VERSIONS: 'USTVA-2026.1,KST-2026.1',
}

describe('production tax operations readiness', () => {
  it('fails closed for missing, non-HTTPS, short-secret and unqualified form configuration without exposing secret material', () => {
    const issues = productionGatewayIssues({ ...qualified, TAX_GATEWAY_URL: 'http://gateway.example', TAX_GATEWAY_CREDENTIAL: 'short', TAX_GATEWAY_QUALIFIED_FORM_VERSIONS: '' }, 'USTVA-2026.1')
    expect(issues.join(' ')).toMatch(/HTTPS/)
    expect(issues.join(' ')).toMatch(/at least 16/)
    expect(issues.join(' ')).toMatch(/has not been qualified/)
    expect(issues.join(' ')).not.toContain('short')
  })
  it('accepts only an explicitly enabled and qualified production configuration', () => {
    expect(productionGatewayIssues(qualified, 'USTVA-2026.1')).toEqual([])
  })
  it('emits bounded monitoring dimensions without accepting credentials or declaration payloads', () => {
    expect(gatewayOperationalEvent('recover', 'timeout', 60000.4)).toEqual({ component: 'official-tax-gateway', action: 'recover', outcome: 'timeout', durationMs: 60000 })
    expect(JSON.stringify(gatewayOperationalEvent('submit', 'http-error', 5, 503))).not.toContain('credential')
  })
  it('blocks production transmission before any gateway call when readiness is incomplete', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => assertProductionGatewayReady('USTVA-2026.1', {})).toThrow(/Production tax submission is disabled/)
    vi.unstubAllEnvs()
  })
  it('reports each operational readiness domain independently and aggregates fail-closed state', () => {
    const report = evaluateTaxReadiness('tenant-a', 'KST', '2026', { gatewayIssues: [], profileIssues: [], mappingIssues: [], formIssues: [], annualProfileIssues: ['missing facts'], ledgerIssues: [], eBilanzIssues: ['missing evidence'], invoiceSequenceIssues: [] })
    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.id === 'annual-profile')).toMatchObject({ ready: false, issues: ['missing facts'] })
    expect(report.checks.find(check => check.id === 'e-bilanz')).toMatchObject({ ready: false })
  })
  it('does not treat the legacy sequence initializer as production onboarding evidence', () => {
    expect(invoiceSequenceReadinessIssues({ nextValue: 42 }, null)).toEqual([expect.stringMatching(/legacy sequence initialization is not production-ready/)])
    expect(invoiceSequenceReadinessIssues({ nextValue: 42 }, { firstUnusedNumber: 42, importedCount: 2, importedNumbersHash: 'a'.repeat(64), confirmedBy: 'admin-a' })).toEqual([])
    expect(invoiceSequenceReadinessIssues({ nextValue: 41 }, { firstUnusedNumber: 42, importedCount: 2, importedNumbersHash: 'a'.repeat(64), confirmedBy: 'admin-a' })).toEqual([expect.stringMatching(/contradicts/)])
  })
})
