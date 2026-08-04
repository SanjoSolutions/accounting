import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertQualifiedDisclosureProtocol, captureDisclosureRemoteResponse, disclosureQualificationEvidence, qualifiedDisclosureCases,
  qualifiedDisclosureContractConfiguration, redactDisclosureProtocol, retainDisclosureQualificationEvidence,
} from './disclosureQualificationContract'

const absoluteProtocolDirectory = process.platform === 'win32' ? 'C:\\disclosure-contract-protocols' : '/tmp/disclosure-contract-protocols'
const validEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test', QUALIFIED_DISCLOSURE_CONTRACT_ENABLED: 'true',
  QUALIFIED_DISCLOSURE_CONTRACT_URL: 'https://disclosure-gateway.example/contract/',
  QUALIFIED_DISCLOSURE_CONTRACT_CREDENTIAL: 'contract-credential-long-enough',
  QUALIFIED_DISCLOSURE_CONTRACT_SUBMITTER_ID: 'identified-test-submitter',
  QUALIFIED_DISCLOSURE_CONTRACT_GATEWAY_ID: 'gateway-staging-1',
  QUALIFIED_DISCLOSURE_CONTRACT_QUALIFICATION_ID: 'ureg-webservice/qualification/2026-v1',
  QUALIFIED_DISCLOSURE_CONTRACT_SCHEMA_VERSION: 'provider-layout-xml/2026.1',
  QUALIFIED_DISCLOSURE_CONTRACT_PROTOCOL_DIR: absoluteProtocolDirectory,
  QUALIFIED_DISCLOSURE_CONTRACT_ALLOW_SUBMISSION: 'true',
  QUALIFIED_DISCLOSURE_CONTRACT_CASES: qualifiedDisclosureCases.join(','),
})

describe('qualified Unternehmensregister disclosure contract configuration', () => {
  it('Given normal local or CI execution, when the contract is loaded, then external submissions remain disabled', () => {
    expect(qualifiedDisclosureContractConfiguration({ NODE_ENV: 'test' })).toEqual({ enabled: false, allowSubmission: false, cases: [] })
  })

  it('Given an authorized provider contract, when it is enabled, then HTTPS, submitter identification, exact schema, complete cases, retention and explicit submission consent are mandatory', () => {
    expect(qualifiedDisclosureContractConfiguration(validEnvironment())).toMatchObject({ enabled: true, endpoint: 'https://disclosure-gateway.example/contract', schemaVersion: 'provider-layout-xml/2026.1' })
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_URL: 'http://disclosure-gateway.example' })).toThrow(/HTTPS/)
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_SUBMITTER_ID: '' })).toThrow(/identified authorized submitter/)
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_SCHEMA_VERSION: '' })).toThrow(/schema version/)
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_CASES: 'MICRO-HINTERLEGUNG' })).toThrow(/exact supported disclosure cases/)
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_ALLOW_SUBMISSION: 'false' })).toThrow(/acceptance evidence/)
  })

  it('Given the external workflow, when its trigger is inspected, then credential-bearing submissions are manual and environment-approved', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/qualified-disclosure-contract.yml'), 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('environment: disclosure-qualification')
    expect(workflow).not.toMatch(/^\s*(push|pull_request):/m)
  })
})

describe('qualified Unternehmensregister disclosure evidence', () => {
  it('Given identifying data and credentials, when a protocol is retained, then sensitive material is redacted while stable protocol identity remains', () => {
    const receiptSha256 = 'b'.repeat(64)
    const serialized = JSON.stringify(redactDisclosureProtocol({ authorization: 'Bearer top-secret', receipt: 'secret-receipt', receiptSha256, malformedReceiptSha256: 'not-a-digest', companyName: 'Example GmbH', nested: { diagnostic: 'credential=top-secret', protocolId: 'safe-id' } }, ['top-secret']))
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('Example GmbH')
    expect(serialized).toContain('safe-id')
    expect(serialized).toContain(receiptSha256)
    expect(serialized).not.toContain('secret-receipt')
    expect(serialized).not.toContain('not-a-digest')
  })

  it('Given a non-JSON provider failure, when the response is captured, then bounded redacted diagnostics and an exact response digest remain available', () => {
    const body = `<html>credential=top-secret ${'x'.repeat(3_000)}</html>`
    const captured = captureDisclosureRemoteResponse(body, 'text/html; charset=utf-8', ['top-secret'])
    expect(captured.parsed).toBeUndefined()
    expect(captured.evidence).toMatchObject({ contentType: 'text/html', bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/), bodyLength: Buffer.byteLength(body) })
    expect(JSON.stringify(captured.evidence)).not.toContain('top-secret')
    expect((captured.evidence as { textExcerpt: string }).textExcerpt.length).toBeLessThanOrEqual(2_048)
  })

  it('Given a contract request, when evidence is constructed, then only non-identifying coordinates and a request digest remain', () => {
    const evidence = disclosureQualificationEvidence({
      config: { gatewayId: 'gateway-1', qualificationId: 'qualification-1', schemaVersion: 'schema-1' }, disclosureCase: 'MICRO-HINTERLEGUNG', fiscalYear: 2026,
      caseName: 'acceptance', request: { submitterId: 'secret-person', companyName: 'Secret GmbH' }, httpStatus: 200, result: {}, protocol: {}, secrets: ['secret-person'],
    })
    expect(evidence).toMatchObject({ disclosureCase: 'MICRO-HINTERLEGUNG', fiscalYear: 2026, requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(JSON.stringify(evidence)).not.toContain('Secret GmbH')
    expect(JSON.stringify(evidence)).not.toContain('secret-person')
  })

  it('Given a claimed official outcome, when protocol identity is checked, then only exact TEST/STAGING Unternehmensregister evidence is accepted', () => {
    const expected = { gatewayId: 'gateway-1', qualificationId: 'qualification-1', schemaVersion: 'schema-1', disclosureCase: 'SMALL-OFFENLEGUNG' as const, stage: 'ACCEPTED' as const }
    const protocol = { ...expected, protocolId: 'protocol-1', timestamp: '2026-08-04T00:00:00Z', environment: 'STAGING', destination: 'UNTERNEHMENSREGISTER' }
    expect(assertQualifiedDisclosureProtocol(protocol, expected)).toEqual(protocol)
    expect(() => assertQualifiedDisclosureProtocol({ ...protocol, environment: 'PRODUCTION' }, expected)).toThrow(/TEST or STAGING/)
    expect(() => assertQualifiedDisclosureProtocol({ ...protocol, destination: 'OTHER' }, expected)).toThrow(/Unternehmensregister/)
    expect(() => assertQualifiedDisclosureProtocol({ ...protocol, schemaVersion: 'unqualified' }, expected)).toThrow(/does not match/)
  })

  it('Given redacted evidence, when it is retained, then it is created once inside the approved absolute directory and cannot be overwritten', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'disclosure-contract-'))
    try {
      const target = await retainDisclosureQualificationEvidence(directory, 'run-1.json', { protocolId: 'safe-id' })
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ protocolId: 'safe-id' })
      await expect(retainDisclosureQualificationEvidence(directory, 'run-1.json', { protocolId: 'replacement' })).rejects.toThrow()
      await expect(retainDisclosureQualificationEvidence(directory, '../outside.json', {})).rejects.toThrow(/filename/)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
