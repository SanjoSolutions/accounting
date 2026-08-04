import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { assertQualifiedGatewayProtocol, qualificationEvidence, qualifiedContractFormVersions, qualifiedGatewayContractConfiguration, redactQualificationProtocol } from './qualificationContract'

const validEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  QUALIFIED_TAX_GATEWAY_CONTRACT_ENABLED: 'true',
  QUALIFIED_TAX_GATEWAY_CONTRACT_URL: 'https://qualified-gateway.example/contract/',
  QUALIFIED_TAX_GATEWAY_CONTRACT_CREDENTIAL: 'contract-credential-long-enough',
  QUALIFIED_TAX_GATEWAY_CONTRACT_TAXPAYER_ID: 'authorized-test-taxpayer',
  QUALIFIED_TAX_GATEWAY_CONTRACT_GATEWAY_ID: 'gateway-staging-1',
  QUALIFIED_TAX_GATEWAY_CONTRACT_QUALIFICATION_ID: 'qualification/2025-forms/v1',
  QUALIFIED_TAX_GATEWAY_CONTRACT_PROTOCOL_DIR: process.platform === 'win32' ? 'C:\\contract-protocols' : '/tmp/contract-protocols',
  QUALIFIED_TAX_GATEWAY_CONTRACT_ALLOW_SUBMISSION: 'true',
  QUALIFIED_TAX_GATEWAY_CONTRACT_FORM_VERSIONS: qualifiedContractFormVersions.join(','),
})

describe('qualified tax gateway contract configuration', () => {
  it('Given no explicit opt-in, when configuration is loaded, then external validation and submission remain disabled', () => {
    expect(qualifiedGatewayContractConfiguration({ NODE_ENV: 'test' })).toEqual({ enabled: false, allowSubmission: false, qualifiedFormVersions: [] })
  })

  it('Given a qualified staging contract, when configuration is loaded, then HTTPS, exact forms, evidence retention and submission consent are required', () => {
    expect(qualifiedGatewayContractConfiguration(validEnvironment())).toMatchObject({ enabled: true, endpoint: 'https://qualified-gateway.example/contract', allowSubmission: true })
    expect(() => qualifiedGatewayContractConfiguration({ ...validEnvironment(), QUALIFIED_TAX_GATEWAY_CONTRACT_URL: 'http://qualified-gateway.example' })).toThrow(/HTTPS/)
    expect(() => qualifiedGatewayContractConfiguration({ ...validEnvironment(), QUALIFIED_TAX_GATEWAY_CONTRACT_ALLOW_SUBMISSION: 'false' })).toThrow(/acceptance evidence/)
    expect(() => qualifiedGatewayContractConfiguration({ ...validEnvironment(), QUALIFIED_TAX_GATEWAY_CONTRACT_FORM_VERSIONS: 'KST-2025.1' })).toThrow(/exact supported/)
  })

  it('Given the externally enabled registry surface, when the exact contract allowlist is inspected, then every 2025 and 2026 supported form version is covered', () => {
    expect(qualifiedContractFormVersions).toEqual([
      'USTVA-2025.1', 'UST_ANNUAL-2025.1', 'KST-2025.1', 'GEWST-2025.1',
      'USTVA-2026.1', 'UST_ANNUAL-2026.1', 'KST-2026.1', 'GEWST-2026.1',
    ])
  })

  it('Given normal repository CI, when workflow triggers are inspected, then the credential-bearing contract remains manual and environment-approved', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/qualified-tax-gateway-contract.yml'), 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('environment: tax-gateway-qualification')
    expect(workflow).not.toMatch(/^\s*(push|pull_request):/m)
  })
})

describe('qualified gateway evidence redaction', () => {
  it('Given secrets and taxpayer data in nested protocol output, when evidence is redacted, then credentials and identifying payloads are removed', () => {
    const serialized = JSON.stringify(redactQualificationProtocol({
      authorization: 'Bearer top-secret', nested: { taxpayerId: 'taxpayer-1', diagnostic: 'credential=top-secret', protocolId: 'safe-id' },
    }, ['top-secret']))
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('taxpayer-1')
    expect(serialized).toContain('safe-id')
  })

  it('Given a declaration object with runtime-only taxpayer facts, when evidence is retained, then only non-identifying form coordinates survive', () => {
    const evidence = qualificationEvidence({
      config: { gatewayId: 'gateway-1', qualificationId: 'qualification-1' },
      dataset: { kind: 'USTVA', period: '2026-01', formVersion: 'USTVA-2026.1', companyId: 'taxpayer-1', fields: { ZAHLLAST: 1900 } } as never,
      caseName: 'validation', request: { taxpayerId: 'taxpayer-1' }, httpStatus: 200, result: {}, protocol: {}, secrets: ['taxpayer-1'],
    })
    expect(evidence.declaration).toEqual({ kind: 'USTVA', period: '2026-01', formVersion: 'USTVA-2026.1' })
    expect(JSON.stringify(evidence)).not.toContain('taxpayer-1')
  })

  it('Given a claimed authority outcome, when protocol identity is asserted, then only exact qualified TEST or STAGING evidence is accepted', () => {
    const expected = { gatewayId: 'gateway-1', qualificationId: 'qualification-1', formVersion: 'KST-2025.1', stage: 'ACCEPTED' as const }
    const protocol = { ...expected, protocolId: 'protocol-1', timestamp: '2026-08-04T00:00:00Z', environment: 'STAGING' }
    expect(assertQualifiedGatewayProtocol(protocol, expected)).toEqual(protocol)
    expect(() => assertQualifiedGatewayProtocol({ ...protocol, environment: 'PRODUCTION' }, expected)).toThrow(/TEST or STAGING/)
    expect(() => assertQualifiedGatewayProtocol({ ...protocol, qualificationId: 'other' }, expected)).toThrow(/does not match/)
  })
})
