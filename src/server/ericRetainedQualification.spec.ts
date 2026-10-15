import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { unzipSync, zipSync, strToU8 } from 'fflate'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { canonicalJson } from '@/core/compliance/auditExport'
import { createAuthoritativeEBalanceDataset, eBalanceChecksum } from '@/core/eBilanzExport'
import { serializeEBalanceFilingXml } from '@/core/eBilanzFilingXml'
import { createEBalancePackage } from '@/core/eBilanzPackage'
import { OFFICIAL_E_BALANCE_TAXONOMIES } from '@/core/eBilanzTaxonomy'
import { readEBalanceTaxonomy } from '@/core/eBilanzTaxonomyModel'
import { eBilanz2026Fixture } from '@/core/fixtures/eBilanz2026'
import { EricProcessingError, type EricResult, type runEric } from './eric'
import { retainedEricConfiguration, runRetainedEricQualification, validateEricRetainedManifest, type EricRetainedQualificationManifest } from './ericRetainedQualification'
import { verifyEricRetainedPackage } from './ericRetainedPackage'

let directory: string
let taxonomyArchive: Uint8Array
let archive: Uint8Array
const commit = 'a'.repeat(40)
const positive: EricResult = { statusCode: 0, statusText: 'private taxpayer details', sent: false,
  resultXml: '<r xmlns="urn:synthetic-contract"><code>VALID</code><private>secret taxpayer</private></r>', serverResponseXml: '' }
const negative = () => new EricProcessingError(1234, 'private negative diagnostic', '<r xmlns="urn:synthetic-contract"><code>DECIMAL</code></r>', '')
const fakeRuntime = { bridgeSha256: eBalanceChecksum('bridge'), apiSha256: eBalanceChecksum('api'), pluginSha256: eBalanceChecksum('plugin') }
const manifest = (): EricRetainedQualificationManifest => ({ schemaVersion: 'ERIC_RETAINED_VALIDATION_V1', dataClassification: 'SYNTHETIC', retainedExportId: 'retained-1', archiveSha256: eBalanceChecksum(archive), repositoryCommit: commit,
  fixtureId: 'synthetic-UG', fixtureVersion: '1', reportVersion: '1', sdkVersion: 'synthetic-only', runtime: { ...fakeRuntime }, diagnosticContractReference: 'unit-test expectations, not SDK evidence',
  positiveDiagnostic: { namespace: 'urn:synthetic-contract', localName: 'code', value: 'VALID' }, negativeDiagnostic: { namespace: 'urn:synthetic-contract', localName: 'code', value: 'DECIMAL' }, negativeStatusCode: 1234 })
const configuration = () => ({ bridgePath: path.join(directory, 'bridge.exe'), runtimeDirectory: directory, manufacturerId: '12345', testMarker: '700000004' })
const input = () => ({ manifest: manifest(), repositoryCommit: commit, archive, taxonomyArchive, configuration: configuration(), testTaxNumber: '1234567890123',
  evidenceDirectory: path.join(directory, 'evidence'), authorizedValidationOnly: true })
const execute = () => vi.fn<typeof runEric>().mockResolvedValueOnce(positive).mockRejectedValueOnce(negative())
const environment = (): NodeJS.ProcessEnv => ({ NODE_ENV: 'test', ERIC_RETAINED_CONTRACT_ENABLED: 'true', ERIC_QUALIFICATION_AUTHORIZED_TEST_MODE: 'true',
  ERIC_QUALIFICATION_BRIDGE_PATH: configuration().bridgePath, ERIC_QUALIFICATION_RUNTIME_DIR: directory,
  ERIC_QUALIFICATION_MANUFACTURER_ID: '12345', ERIC_QUALIFICATION_TEST_MARKER: '700000004', ERIC_QUALIFICATION_TEST_TAX_NUMBER: '1234567890123',
  ERIC_RETAINED_PACKAGE_PATH: path.join(directory, 'export.zip'), ERIC_RETAINED_MANIFEST_PATH: path.join(directory, 'manifest.json'), ERIC_QUALIFICATION_EVIDENCE_DIR: path.join(directory, 'evidence') })

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'eric-retained-unit-'))
  await mkdir(path.join(directory, 'plugins'))
  await writeFile(configuration().bridgePath, 'bridge')
  await writeFile(path.join(directory, 'ericapi.dll'), 'api')
  await writeFile(path.join(directory, 'plugins/checkBilanz_6_9.dll'), 'plugin')
  const release = OFFICIAL_E_BALANCE_TAXONOMIES[0]
  taxonomyArchive = await readFile(path.join(process.cwd(), 'public/taxonomies', release.archiveFile))
  const source = eBilanz2026Fixture()
  source.company.companyName = 'Synthetic\nmultiline company'
  const dataset = createAuthoritativeEBalanceDataset(source, readEBalanceTaxonomy(release, taxonomyArchive))
  const xml = serializeEBalanceFilingXml(dataset)
  archive = createEBalancePackage(xml, dataset.fiscalYear.year, taxonomyArchive, {
    'export-data.json': canonicalJson(dataset), 'local-validation.json': JSON.stringify({ level: 'LOCAL_STRUCTURAL', valid: true, reportChecksum: eBalanceChecksum(xml) }),
    'manifest.json': JSON.stringify({ format: 'EBILANZ_EXPORT_V1', closeGenerationId: dataset.closeGenerationId, datasetChecksum: eBalanceChecksum(canonicalJson(dataset)),
      reportChecksum: eBalanceChecksum(xml), reconciliationChecksum: dataset.reconciliation.checksum, taxonomyArchiveSha256: release.archiveSha256 }),
  })
})
afterAll(async () => { if (directory) await rm(directory, { recursive: true, force: true }) })

describe('Retained app-generated ERiC validation inputs', () => {
  test('Given ordinary tests, when configuration is loaded, then official execution stays disabled', () => {
    expect(retainedEricConfiguration({ NODE_ENV: 'test' })).toBeNull()
    expect(retainedEricConfiguration(environment())?.configuration).toEqual(configuration())
  })
  test('Given disabled execution, when the qualification command runs, then it fails instead of claiming a successful skipped contract', () => {
    const result = spawnSync(process.execPath, ['tools/eric-retained-contract.mjs'], { env: { ...process.env, ERIC_RETAINED_CONTRACT_ENABLED: 'false' }, encoding: 'utf8', windowsHide: true })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('authorized retained-package validation')
  })
  test('Given the retained CI contract, when its trigger and artifact scope are checked, then only approved manual validation and redacted root summaries are exposed', async () => {
    const workflow = await readFile(path.join(process.cwd(), '.github/workflows/eric-retained-validation-contract.yml'), 'utf8')
    expect(workflow).toContain('workflow_dispatch:')
    expect(workflow).toContain('environment: eric-test-qualification')
    expect(workflow).toContain("if: inputs.authorization == 'AUTHORIZED_VALIDATION_ONLY'")
    expect(workflow).toContain("ERIC_RETAINED_CONTRACT_ENABLED: 'true'")
    expect(workflow).toContain('pnpm test:contract:eric')
    expect(workflow).toContain('\\*.json')
    expect(workflow).not.toContain('\\**')
    expect(workflow).not.toMatch(/^\s*(push|pull_request):/m)
    expect(workflow).not.toContain('CERTIFICATE')
    expect(workflow).not.toContain('PIN')
  })
  test.each([
    ['ERIC_RETAINED_CONTRACT_ENABLED', 'yes'], ['ERIC_QUALIFICATION_AUTHORIZED_TEST_MODE', 'false'], ['ERIC_QUALIFICATION_TEST_MARKER', ''],
    ['ERIC_QUALIFICATION_TEST_TAX_NUMBER', '123'], ['ERIC_RETAINED_PACKAGE_PATH', 'relative.zip'], ['ERIC_QUALIFICATION_CERTIFICATE_PATH', 'certificate.pfx'], ['ERIC_QUALIFICATION_PIN', 'private'],
  ])('Given invalid %s, when enabled configuration is loaded, then execution fails closed', (key, value) => {
    expect(() => retainedEricConfiguration({ ...environment(), [key]: value })).toThrow()
  })
  test('Given a retained app export, when it is verified, then both instance forms and the negative mutation are bound to exact digests', () => {
    const result = verifyEricRetainedPackage(archive, eBalanceChecksum(archive), taxonomyArchive)
    expect(result.binding.archiveSha256).toBe(eBalanceChecksum(archive))
    expect(result.ericXbrl).toBe(serializeEBalanceFilingXml(result.dataset, true))
    expect(result.invalidXbrl).toContain('>INVALID_DECIMAL</de-gaap-ci:bs.ass>')
    expect(result.binding.invalidXbrlSha256).not.toBe(result.binding.ericXbrlSha256)
  })
  test('Given an official sample or changed archive, when verification runs, then it cannot stand in for the retained app package', () => {
    expect(() => verifyEricRetainedPackage(archive, 'b'.repeat(64), taxonomyArchive)).toThrow(/checksum/)
    const sample = zipSync({ 'e-bilanz-2026.xbrl': strToU8('<xbrli:xbrl/>') })
    expect(() => verifyEricRetainedPackage(sample, eBalanceChecksum(sample), taxonomyArchive)).toThrow(/taxonomy|companion/)
  })
  test.each(['xml', 'dataset', 'diagnostics', 'manifest', 'extra-instance', 'taxonomy', 'packaged-schema', 'unexpected-member'])('Given changed %s, when the outer checksum is refreshed, then internal evidence still fails', kind => {
    const files = unzipSync(archive)
    if (kind === 'xml') files['e-bilanz-2026.xbrl'] = strToU8(new TextDecoder().decode(files['e-bilanz-2026.xbrl']).replace('Synthetic', 'Tampered'))
    if (kind === 'dataset') files['export-data.json'] = strToU8(new TextDecoder().decode(files['export-data.json']).replace('Synthetic', 'Tampered'))
    if (kind === 'diagnostics') files['local-validation.json'] = strToU8('{"level":"LOCAL_STRUCTURAL","valid":true,"reportChecksum":"wrong"}')
    if (kind === 'manifest') files['manifest.json'] = strToU8('{}')
    if (kind === 'extra-instance') files['e-bilanz-2025.xbrl'] = files['e-bilanz-2026.xbrl']
    if (kind === 'packaged-schema') files[OFFICIAL_E_BALANCE_TAXONOMIES[0].entryPoint] = strToU8('<schema/>')
    if (kind === 'unexpected-member') files['../outside.xml'] = strToU8('invalid')
    const changed = zipSync(files)
    expect(() => verifyEricRetainedPackage(changed, eBalanceChecksum(changed), kind === 'taxonomy' ? strToU8('wrong') : taxonomyArchive)).toThrow()
  })
  test('Given a mismatched commit or undocumented status, when the contract is inspected, then no qualification identity is accepted', () => {
    expect(() => validateEricRetainedManifest(manifest(), 'b'.repeat(40))).toThrow(/commit/)
    expect(() => validateEricRetainedManifest({ ...manifest(), negativeStatusCode: 0 }, commit)).toThrow(/content-rejection/)
    expect(() => validateEricRetainedManifest({ ...manifest(), negativeDiagnostic: manifest().positiveDiagnostic }, commit)).toThrow(/distinct/)
  })
})

describe('Retained ERiC validation evidence', () => {
  test('Given positive validation and documented content rejection, when execution finishes, then both protocols are retained without submitting or qualifying production', async () => {
    const bridge = execute()
    const candidate = input()
    Object.assign(candidate.manifest.runtime, { privateNote: 'unreviewed-private-runtime-note' })
    const result = await runRetainedEricQualification(candidate, bridge)
    expect(result.passed).toBe(true)
    expect(result.cases).toHaveLength(2)
    for (const [envelope, options] of bridge.mock.calls) {
      expect(options).toEqual({ send: false, configuration: { ...configuration(), certificatePath: undefined } })
      expect(envelope).toContain('Synthetic\nmultiline company')
    }
    const evidence = JSON.stringify(result)
    expect(evidence).not.toContain('secret taxpayer')
    expect(evidence).not.toContain('private taxpayer')
    expect(evidence).not.toContain('1234567890123')
    expect(evidence).not.toContain('unreviewed-private-runtime-note')
    expect(result.cases.every(record => record.productionQualified === false)).toBe(true)
    const record = result.cases[0]
    expect(JSON.parse(await readFile(path.join(input().evidenceDirectory, `${record.attempt}-positive.json`), 'utf8'))).toEqual(record)
    expect(await readFile(path.join(input().evidenceDirectory, 'private', record.attempt, 'export.zip'))).toEqual(Buffer.from(archive))
  })
  test.each(['authorization', 'certificate', 'test-identity', 'runtime'])('Given invalid %s, when qualification starts, then no bridge call occurs', async kind => {
    const candidate = input()
    if (kind === 'authorization') candidate.authorizedValidationOnly = false
    if (kind === 'certificate') Object.assign(candidate.configuration, { certificatePath: 'private.pfx' })
    if (kind === 'test-identity') candidate.testTaxNumber = '9999999999999'
    if (kind === 'runtime') candidate.manifest.runtime.apiSha256 = 'f'.repeat(64)
    const bridge = execute()
    await expect(runRetainedEricQualification(candidate, bridge)).rejects.toThrow()
    expect(bridge).not.toHaveBeenCalled()
  })
  test.each([
    ['test-marker response', { ...positive, statusCode: 610301202 }],
    ['wrong namespace', { ...positive, resultXml: '<r xmlns="urn:wrong"><code>VALID</code></r>' }],
    ['missing diagnostic', { ...positive, resultXml: '<r/>' }],
    ['malformed diagnostic', { ...positive, resultXml: '<r>' }],
    ['unexpected send', { ...positive, sent: true }],
    ['unexpected receipt', { ...positive, serverResponseXml: '<receipt/>' }],
  ])('Given %s, when the positive case runs, then evidence fails without promoting production', async (_label, response) => {
    const bridge = vi.fn<typeof runEric>().mockResolvedValueOnce(response).mockRejectedValueOnce(negative())
    const result = await runRetainedEricQualification(input(), bridge)
    expect(result.passed).toBe(false)
    expect(result.cases[0].passed).toBe(false)
    expect(result.cases[1].passed).toBe(true)
  })
  test('Given an installation error for the invalid case, when evidence is evaluated, then it cannot count as content rejection', async () => {
    const bridge = vi.fn<typeof runEric>().mockResolvedValueOnce(positive).mockRejectedValueOnce(new EricProcessingError(-1, 'missing DLL', '', ''))
    const result = await runRetainedEricQualification(input(), bridge)
    expect(result.passed).toBe(false)
    expect(result.cases[1].observed?.statusCode).toBe(-1)
  })
  test('Given a negative response reporting a send, when the processing error is retained, then it fails the validation-only contract', async () => {
    const error = negative()
    const bridge = vi.fn<typeof runEric>().mockResolvedValueOnce(positive).mockRejectedValueOnce(new EricProcessingError(error.statusCode, error.message, error.resultXml, '', true))
    const result = await runRetainedEricQualification(input(), bridge)
    expect(result.passed).toBe(false)
    expect(result.cases[1].observed?.sent).toBe(true)
  })
  test('Given an uncertain bridge failure, when validation runs, then failures are retained without automatic retries or secret text', async () => {
    const bridge = vi.fn<typeof runEric>().mockRejectedValue(new Error('timeout private-token'))
    const result = await runRetainedEricQualification(input(), bridge)
    expect(result.passed).toBe(false)
    expect(bridge).toHaveBeenCalledTimes(2)
    expect(result.cases.every(record => record.failureSha256 && record.observed === null)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('private-token')
  })
  test('Given complete-looking diagnostics followed by abnormal process exit, when evidence is evaluated, then neither apparent success nor rejection counts as completed validation', async () => {
    const rejection = negative()
    const bridge = vi.fn<typeof runEric>()
      .mockRejectedValueOnce(new EricProcessingError(0, positive.statusText, positive.resultXml, '', false, false))
      .mockRejectedValueOnce(new EricProcessingError(rejection.statusCode, rejection.message, rejection.resultXml, '', false, false))
    const result = await runRetainedEricQualification(input(), bridge)
    expect(result.passed).toBe(false)
    expect(result.cases.every(record => !record.passed && !record.bridgeCompleted && record.observed?.diagnosticMatched)).toBe(true)
  })
  test('Given a changed runtime during execution, when the post-call pin is checked, then the result is not accepted', async () => {
    const bridge = vi.fn<typeof runEric>().mockImplementation(async () => { await writeFile(path.join(directory, 'ericapi.dll'), 'changed'); return positive })
    try {
      const result = await runRetainedEricQualification(input(), bridge)
      expect(result.passed).toBe(false)
      expect(result.cases.every(record => !record.runtimeUnchanged)).toBe(true)
      expect(bridge).toHaveBeenCalledTimes(1)
    } finally { await writeFile(path.join(directory, 'ericapi.dll'), 'api') }
  })
  test('Given repeated validation of the same bytes, when execution is repeated, then the identity is stable and evidence is append-only', async () => {
    const first = await runRetainedEricQualification(input(), execute())
    const second = await runRetainedEricQualification(input(), execute())
    expect(first.qualificationId).toBe(second.qualificationId)
    expect(first.cases[0].attempt).not.toBe(second.cases[0].attempt)
    const files = await readdir(input().evidenceDirectory)
    expect(files).toContain(`${first.cases[0].attempt}-positive.json`)
    expect(files).toContain(`${second.cases[0].attempt}-positive.json`)
    const correctedVersion = input()
    correctedVersion.manifest.reportVersion = '2'
    const third = await runRetainedEricQualification(correctedVersion, execute())
    expect(third.qualificationId).not.toBe(first.qualificationId)
  })
})
