import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ericQualificationContractConfiguration, ericXmlEvidence, redactEricContractText } from './ericQualificationContract'

const absolute = (name: string) => process.platform === 'win32' ? `C:\\eric\\${name}` : `/opt/eric/${name}`
const validEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  ERIC_QUALIFICATION_CONTRACT_ENABLED: 'true',
  ERIC_QUALIFICATION_AUTHORIZED_TEST_MODE: 'true',
  ERIC_QUALIFICATION_BRIDGE_PATH: absolute('eric-bridge.exe'),
  ERIC_QUALIFICATION_RUNTIME_DIR: absolute('runtime'),
  ERIC_QUALIFICATION_MANUFACTURER_ID: '12345',
  ERIC_QUALIFICATION_TEST_MARKER: '700000004',
  ERIC_QUALIFICATION_TEST_TAX_NUMBER: '5192050001276',
  ERIC_QUALIFICATION_SAMPLE_XBRL: absolute('sample.xml'),
  ERIC_QUALIFICATION_EXPECTED_OUTCOME: 'TEST_MARKER_RESPONSE',
  ERIC_QUALIFICATION_EXPECTED_STATUS_CODE: '610301202',
  ERIC_QUALIFICATION_EXPECTED_STATUS_TEXT: 'Testmerker',
  ERIC_QUALIFICATION_EVIDENCE_DIR: absolute('evidence'),
})

describe('ERiC native qualification contract configuration', () => {
  it('Given ordinary local or CI execution, when configuration is loaded, then the proprietary contract remains disabled and produces no evidence claim', () => {
    expect(ericQualificationContractConfiguration({ NODE_ENV: 'test' })).toEqual({ enabled: false, authorizedTestMode: false })
  })

  it('Given an enabled contract, when authorized test inputs are incomplete, then it fails closed before invoking ERiC', () => {
    expect(() => ericQualificationContractConfiguration({ ...validEnvironment(), ERIC_QUALIFICATION_AUTHORIZED_TEST_MODE: 'false' })).toThrow(/authorized ERiC test mode/)
    expect(() => ericQualificationContractConfiguration({ ...validEnvironment(), ERIC_QUALIFICATION_SAMPLE_XBRL: 'relative.xml' })).toThrow(/sample XBRL path must be absolute/)
    expect(() => ericQualificationContractConfiguration({ ...validEnvironment(), ERIC_QUALIFICATION_CERTIFICATE_PATH: absolute('certificate.pfx') })).toThrow(/forbidden/)
  })

  it('Given a documented result contract, when outcome configuration is checked, then success and explicit test-marker responses require exact compatible status evidence', () => {
    expect(ericQualificationContractConfiguration(validEnvironment())).toMatchObject({ enabled: true, expectedOutcome: 'TEST_MARKER_RESPONSE', expectedStatusCode: 610301202 })
    expect(() => ericQualificationContractConfiguration({ ...validEnvironment(), ERIC_QUALIFICATION_EXPECTED_OUTCOME: 'SUCCESS', ERIC_QUALIFICATION_EXPECTED_STATUS_CODE: '610301202' })).toThrow(/status code 0/)
    expect(() => ericQualificationContractConfiguration({ ...validEnvironment(), ERIC_QUALIFICATION_EXPECTED_STATUS_TEXT: '' })).toThrow(/status-text fragment/)
  })

  it('Given repository CI, when the native ERiC workflow is inspected, then only manual environment-approved validation can run', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/eric-bilanz-validation-contract.yml'), 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('environment: eric-test-qualification')
    expect(workflow).toContain("AUTHORIZED_VALIDATION_ONLY")
    expect(workflow).not.toMatch(/^\s*(push|pull_request):/m)
    expect(workflow).not.toContain('CERTIFICATE')
    expect(workflow).not.toContain('PIN')
  })
})

describe('ERiC native qualification evidence redaction', () => {
  it('Given result and server-response XML with taxpayer facts, when evidence is retained, then only hashes, sizes and a bounded redacted preview remain', () => {
    const xml = '<Eric tenant="hidden-tenant"><Steuernummer>5192050001276</Steuernummer><name>Example UG</name><diagnostic>arbitrary private fact</diagnostic><status>Testmerker 700000004</status></Eric>'
    const evidence = ericXmlEvidence(xml, ['700000004'])
    expect(evidence.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(evidence.bytes).toBeGreaterThan(0)
    expect(evidence.redactedPreview).not.toContain('5192050001276')
    expect(evidence.redactedPreview).not.toContain('Example UG')
    expect(evidence.redactedPreview).not.toContain('700000004')
    expect(evidence.redactedPreview).not.toContain('hidden-tenant')
    expect(evidence.redactedPreview).not.toContain('arbitrary private fact')
  })

  it('Given bearer credentials or explicit secrets in diagnostics, when text is redacted, then neither can enter retained protocols', () => {
    expect(redactEricContractText('Bearer top-secret diagnostic=top-secret', ['top-secret'])).toBe('Bearer [REDACTED] diagnostic=[REDACTED]')
  })
})
