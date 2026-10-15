import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  assertQualifiedDisclosureProtocol, assertQualifiedDisclosureResponse, captureDisclosureRemoteResponse, disclosureQualificationEvidence, qualifiedDisclosureCases,
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
  QUALIFIED_DISCLOSURE_CONTRACT_ENVIRONMENT: 'STAGING',
  QUALIFIED_DISCLOSURE_CONTRACT_FIXTURE_DIR: absoluteProtocolDirectory,
  QUALIFIED_DISCLOSURE_CONTRACT_FIXTURE_MANIFEST_SHA256: 'f'.repeat(64),
  QUALIFIED_DISCLOSURE_CONTRACT_ALLOW_SUBMISSION: 'true',
  QUALIFIED_DISCLOSURE_CONTRACT_CASES: qualifiedDisclosureCases.join(','),
})

describe('qualified Unternehmensregister disclosure contract configuration', () => {
  test('Given normal local or CI execution, when the contract is loaded, then external submissions remain disabled', () => {
    expect(qualifiedDisclosureContractConfiguration({ NODE_ENV: 'test' })).toEqual({ enabled: false, allowSubmission: false, cases: [] })
  })

  test('Given an authorized provider contract, when it is enabled, then HTTPS, submitter identification, exact schema, complete cases, retention and explicit submission consent are mandatory', () => {
    expect(qualifiedDisclosureContractConfiguration(validEnvironment())).toMatchObject({ enabled: true, endpoint: 'https://disclosure-gateway.example/contract', schemaVersion: 'provider-layout-xml/2026.1' })
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_URL: 'http://disclosure-gateway.example' })).toThrow(/HTTPS/)
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_SUBMITTER_ID: '' })).toThrow(/identified authorized submitter/)
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_SCHEMA_VERSION: '' })).toThrow(/schema version/)
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_CASES: 'MICRO-HINTERLEGUNG' })).toThrow(/exact supported disclosure cases/)
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_ALLOW_SUBMISSION: 'false' })).toThrow(/acceptance evidence/)
  })

  test('Given the external workflow, when its trigger is inspected, then credential-bearing submissions are manual and environment-approved', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/qualified-disclosure-contract.yml'), 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('environment: disclosure-qualification')
    expect(workflow).not.toMatch(/^\s*(push|pull_request):/m)
    expect(workflow).toContain('actions/download-artifact@v4')
    expect(workflow).toContain('QUALIFIED_DISCLOSURE_CONTRACT_FIXTURE_MANIFEST_SHA256')
    expect(workflow).toContain('if-no-files-found: error')
  })

  test.each(['', 'PRODUCTION', 'test'])('Given environment %s, when configured, then requests are blocked before transport', target => {
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_ENVIRONMENT: target })).toThrow(/exact TEST or STAGING/)
  })
  test('Given missing fixture approval or an ambiguous endpoint, when configured, then it fails closed', () => {
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_FIXTURE_DIR: 'relative' })).toThrow(/fixture directory/)
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_FIXTURE_MANIFEST_SHA256: '' })).toThrow(/SHA-256 pin/)
    expect(() => qualifiedDisclosureContractConfiguration({ ...validEnvironment(), QUALIFIED_DISCLOSURE_CONTRACT_URL: 'https://gateway.example?mode=production' })).toThrow(/query/)
  })
})

describe('qualified Unternehmensregister disclosure evidence', () => {
  test.each(qualifiedDisclosureCases)('Given %s protocol bytes, when responses are checked, then validation, rejection, acceptance and exact replay are required', disclosureCase => {
    const expected = { gatewayId: 'gateway-1', qualificationId: 'qualification-1', schemaVersion: 'schema-1', disclosureCase, environment: 'TEST' as const, submitterId: 'synthetic-submitter', sourcePackageChecksum: 'a'.repeat(64), packageSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), fiscalYear: 2026 }
    const protocol = { ...expected, protocolId: 'protocol-1', timestamp: '2026-10-15T09:00:00Z', destination: 'UNTERNEHMENSREGISTER', nonBinding: true }
    const receipt = 'unit-receipt-not-provider-evidence'
    const receiptSha256 = createHash('sha256').update(receipt).digest('hex')
    const acceptedBody = { outcome: 'accepted', errors: [], receipt, protocol: { ...protocol, stage: 'ACCEPTED', receiptSha256 } }
    const accepted = assertQualifiedDisclosureResponse(200, acceptedBody, { ...expected, stage: 'ACCEPTED' })
    expect(assertQualifiedDisclosureResponse(200, acceptedBody, { ...expected, stage: 'ACCEPTED' }, accepted)).toEqual(accepted)
    expect(() => assertQualifiedDisclosureResponse(200, acceptedBody, { ...expected, stage: 'ACCEPTED' }, { ...accepted, receiptSha256: 'd'.repeat(64) })).toThrow(/replay/)
    expect(() => assertQualifiedDisclosureResponse(200, acceptedBody, { ...expected, stage: 'ACCEPTED' }, { ...accepted, protocol: { ...accepted.protocol, protocolId: 'different' } })).toThrow(/replay/)
    for (const changes of [{ outcome: 'pending' }, { receipt: ' ' }, { errors: ['provider-private-diagnostic'] }, { errors: undefined }]) {
      expect(() => assertQualifiedDisclosureResponse(200, { ...acceptedBody, ...changes }, { ...expected, stage: 'ACCEPTED' })).toThrow()
    }
    expect(() => assertQualifiedDisclosureResponse(302, acceptedBody, { ...expected, stage: 'ACCEPTED' })).toThrow(/HTTP/)
    for (const stage of ['VALIDATED', 'REJECTED'] as const) {
      const body = { valid: stage === 'VALIDATED', errors: stage === 'VALIDATED' ? [] : ['intentionally invalid unit fixture'], protocol: { ...protocol, stage } }
      expect(assertQualifiedDisclosureResponse(200, body, { ...expected, stage }).protocol.stage).toBe(stage)
      expect(() => assertQualifiedDisclosureResponse(200, { ...body, valid: !body.valid }, { ...expected, stage })).toThrow()
      expect(() => assertQualifiedDisclosureResponse(200, { ...body, errors: stage === 'VALIDATED' ? ['private diagnostic'] : [' '] }, { ...expected, stage })).toThrow()
    }
  })

  test('Given identifying data and credentials, when a protocol is retained, then sensitive material is redacted while stable protocol identity remains', () => {
    const receiptSha256 = 'b'.repeat(64)
    const serialized = JSON.stringify(redactDisclosureProtocol({ authorization: 'Bearer top-secret', receipt: 'secret-receipt', receiptSha256, malformedReceiptSha256: 'not-a-digest', companyName: 'Example GmbH', nested: { diagnostic: 'credential=top-secret', protocolId: 'safe-id' } }, ['top-secret']))
    expect(serialized).not.toContain('top-secret')
    expect(serialized).not.toContain('Example GmbH')
    expect(serialized).toContain('safe-id')
    expect(serialized).toContain(receiptSha256)
    expect(serialized).not.toContain('secret-receipt')
    expect(serialized).not.toContain('not-a-digest')
  })

  test('Given private provider prose in JSON or HTML, when captured, then only response metadata and an exact digest are retained', () => {
    const body = `<html>credential=top-secret ${'x'.repeat(3_000)}</html>`
    const captured = captureDisclosureRemoteResponse(body, 'text/html; charset=utf-8', ['top-secret'])
    expect(captured.parsed).toBeUndefined()
    expect(captured.evidence).toMatchObject({ contentType: 'text/html', bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/), bodyLength: Buffer.byteLength(body) })
    expect(JSON.stringify(captured.evidence)).not.toContain('top-secret')
    expect(captured.evidence).not.toHaveProperty('textExcerpt')
    const json = captureDisclosureRemoteResponse(JSON.stringify({ unusualField: 'Secret GmbH', message: 'top-secret' }), 'application/json')
    expect(JSON.stringify(json.evidence)).not.toMatch(/Secret GmbH|top-secret/)
  })

  test('Given a contract request, when evidence is constructed, then only non-identifying coordinates and a request digest remain', () => {
    const evidence = disclosureQualificationEvidence({
      config: { gatewayId: 'gateway-1', qualificationId: 'qualification-1', schemaVersion: 'schema-1', environment: 'TEST', submitterId: 'secret-person' }, disclosureCase: 'MICRO-HINTERLEGUNG', fiscalYear: 2026,
      caseName: 'acceptance', request: { submitterId: 'secret-person', companyName: 'Secret GmbH' }, httpStatus: 200, result: {}, protocol: {}, secrets: ['secret-person'],
      binding: { manifestSha256: 'a'.repeat(64), annualBundleSha256: 'b'.repeat(64), manualBundleSha256: 'c'.repeat(64), sourcePackageChecksum: 'd'.repeat(64), packageSha256: 'e'.repeat(64), adapterVersion: 'adapter-1' }, contractPassed: false,
    })
    expect(evidence).toMatchObject({ disclosureCase: 'MICRO-HINTERLEGUNG', fiscalYear: 2026, requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(JSON.stringify(evidence)).not.toContain('Secret GmbH')
    expect(JSON.stringify(evidence)).not.toContain('secret-person')
    expect(evidence).toMatchObject({ version: 2, contractPassed: false, submitterSha256: expect.stringMatching(/^[a-f0-9]{64}$/), binding: { packageSha256: 'e'.repeat(64) } })
  })

  test('Given a claimed official outcome, when protocol identity is checked, then only exact TEST/STAGING Unternehmensregister evidence is accepted', () => {
    const expected = { gatewayId: 'gateway-1', qualificationId: 'qualification-1', schemaVersion: 'schema-1', disclosureCase: 'SMALL-OFFENLEGUNG' as const, stage: 'ACCEPTED' as const, environment: 'STAGING' as const, submitterId: 'identified-submitter', sourcePackageChecksum: 'a'.repeat(64), packageSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), receiptSha256: 'd'.repeat(64), fiscalYear: 2026 }
    const protocol = { ...expected, protocolId: 'protocol-1', timestamp: '2026-08-04T00:00:00Z', destination: 'UNTERNEHMENSREGISTER', nonBinding: true }
    expect(assertQualifiedDisclosureProtocol(protocol, expected)).toEqual(protocol)
    expect(() => assertQualifiedDisclosureProtocol({ ...protocol, environment: 'PRODUCTION' }, expected)).toThrow(/TEST or STAGING/)
    expect(() => assertQualifiedDisclosureProtocol({ ...protocol, destination: 'OTHER' }, expected)).toThrow(/Unternehmensregister/)
    expect(() => assertQualifiedDisclosureProtocol({ ...protocol, schemaVersion: 'unqualified' }, expected)).toThrow(/does not match/)
    for (const field of ['submitterId', 'sourcePackageChecksum', 'packageSha256', 'requestSha256', 'fiscalYear', 'receiptSha256']) {
      expect(() => assertQualifiedDisclosureProtocol({ ...protocol, [field]: undefined }, expected)).toThrow()
      expect(() => assertQualifiedDisclosureProtocol({ ...protocol, [field]: 'different' }, expected)).toThrow()
    }
    expect(() => assertQualifiedDisclosureProtocol({ ...protocol, environment: 'TEST' }, expected)).toThrow(/does not match/)
    expect(() => assertQualifiedDisclosureProtocol({ ...protocol, nonBinding: false }, expected)).toThrow(/non-binding/)
  })

  test('Given redacted evidence, when it is retained, then it is created once inside the approved absolute directory and cannot be overwritten', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'disclosure-contract-'))
    try {
      const target = await retainDisclosureQualificationEvidence(directory, 'run-1.json', { protocolId: 'safe-id' })
      expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ protocolId: 'safe-id' })
      await expect(retainDisclosureQualificationEvidence(directory, 'run-1.json', { protocolId: 'replacement' })).rejects.toThrow()
      await expect(retainDisclosureQualificationEvidence(directory, '../outside.json', {})).rejects.toThrow(/filename/)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
