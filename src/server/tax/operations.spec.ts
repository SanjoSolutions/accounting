import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: {} }))
import { assertProductionGatewayReady, evaluateTaxReadiness, gatewayOperationalEvent, invoiceSequenceReadinessIssues, productionGatewayIssues } from './operations'

const qualified = {
  TAX_GATEWAY_URL: 'https://gateway.example/api', TAX_GATEWAY_CREDENTIAL: 'test-only-gateway-material',
  ANNUAL_TAX_CALCULATOR_URL: 'https://calculator.example/api', ANNUAL_TAX_CALCULATOR_CREDENTIAL: 'test-only-calculator-material',
  TAX_PRODUCTION_FILING_ENABLED: 'true', TAX_GATEWAY_QUALIFICATION_ID: 'qualification-2026-07-21',
  TAX_GATEWAY_QUALIFIED_FORM_VERSIONS: 'USTVA-2026.1,KST-2026.1',
  TAX_PROFESSIONAL_REVIEW_ID: 'professional-review-2026', TAX_PROFESSIONALLY_REVIEWED_FORM_VERSIONS: 'USTVA-2026.1,KST-2026.1',
}

describe('production tax operations readiness', () => {
  afterEach(() => vi.unstubAllEnvs())
  test('Given qualified gateway configuration, when professional review is absent or covers a different form, then production remains disabled', () => {
    expect(productionGatewayIssues({ ...qualified, TAX_PROFESSIONAL_REVIEW_ID: '' }, 'USTVA-2026.1')).toContainEqual(expect.stringMatching(/professional German tax sign-off/))
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => assertProductionGatewayReady('USTVA-2026.1', { ...qualified, TAX_PROFESSIONALLY_REVIEWED_FORM_VERSIONS: 'USTVA-2025.1' }, 'USTVA')).toThrow(/no recorded professional/)
    expect(() => assertProductionGatewayReady('USTVA-2026.1', qualified, 'USTVA')).not.toThrow()
  })
  test('Given unsafe transport or missing qualification, when readiness is evaluated, then it fails closed without exposing secret material', () => {
    const issues = productionGatewayIssues({ ...qualified, TAX_GATEWAY_URL: 'http://gateway.example', TAX_GATEWAY_CREDENTIAL: 'short', TAX_GATEWAY_QUALIFIED_FORM_VERSIONS: '' }, 'USTVA-2026.1')
    expect(issues.join(' ')).toMatch(/HTTPS/)
    expect(issues.join(' ')).toMatch(/at least 16/)
    expect(issues.join(' ')).toMatch(/has not been qualified/)
    expect(issues.join(' ')).not.toContain('short')
  })
  test('Given enabled, qualified and professionally reviewed configuration, when readiness is evaluated, then no gateway issues remain', () => {
    expect(productionGatewayIssues(qualified, 'USTVA-2026.1')).toEqual([])
  })
  test('Given a missing annual-tax calculator, when readiness is evaluated, then only income-tax forms require it', () => {
    const vatOnly = { ...qualified, ANNUAL_TAX_CALCULATOR_URL: undefined, ANNUAL_TAX_CALCULATOR_CREDENTIAL: undefined }
    expect(productionGatewayIssues(vatOnly, 'USTVA-2026.1', 'USTVA')).toEqual([])
    expect(productionGatewayIssues(vatOnly, 'UST_ANNUAL-2026.1', 'UST_ANNUAL')).not.toContain(expect.stringMatching(/annual-tax calculator/))
    expect(productionGatewayIssues(vatOnly, 'KST-2026.1', 'KST').join(' ')).toMatch(/annual-tax calculator/)
  })
  test('Given a timeout or HTTP failure, when an operational event is recorded, then it contains only bounded monitoring dimensions', () => {
    expect(gatewayOperationalEvent('recover', 'timeout', 60000.4)).toEqual({ component: 'official-tax-gateway', action: 'recover', outcome: 'timeout', durationMs: 60000 })
    expect(JSON.stringify(gatewayOperationalEvent('submit', 'http-error', 5, 503))).not.toContain('credential')
  })
  test('Given incomplete configuration, when production transmission is attempted, then readiness blocks the gateway call', () => {
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => assertProductionGatewayReady('USTVA-2026.1', {})).toThrow(/Production tax submission is disabled/)
  })
  test('Given missing annual facts and E-Bilanz evidence, when readiness is evaluated, then each domain reports its own blockers', () => {
    const report = evaluateTaxReadiness('tenant-a', 'KST', '2026', { gatewayIssues: [], profileIssues: [], mappingIssues: [], formIssues: [], annualProfileIssues: ['missing facts'], ledgerIssues: [], eBilanzIssues: ['missing evidence'], invoiceSequenceIssues: [] })
    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.id === 'annual-profile')).toMatchObject({ ready: false, issues: ['missing facts'] })
    expect(report.checks.find(check => check.id === 'e-bilanz')).toMatchObject({ ready: false })
  })
  test('Given a legacy sequence, when production onboarding is checked, then immutable reconciliation evidence is required', () => {
    expect(invoiceSequenceReadinessIssues({ nextValue: 42 }, null)).toEqual([expect.stringMatching(/legacy sequence initialization is not production-ready/)])
    expect(invoiceSequenceReadinessIssues({ nextValue: 42 }, { firstUnusedNumber: 42, importedCount: 2, importedNumbersHash: 'a'.repeat(64), confirmedBy: 'admin-a' })).toEqual([])
    expect(invoiceSequenceReadinessIssues({ nextValue: 41 }, { firstUnusedNumber: 42, importedCount: 2, importedNumbersHash: 'a'.repeat(64), confirmedBy: 'admin-a' })).toEqual([expect.stringMatching(/contradicts/)])
  })
})
