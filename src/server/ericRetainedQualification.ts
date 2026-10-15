import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson } from '@/core/compliance/auditExport'
import { eBalanceChecksum } from '@/core/eBilanzExport'
import { createElsterEBalanceEnvelope } from '@/core/elsterEnvelope'
import { parseEBalanceXml, xmlDescendants } from '@/core/eBilanzXml'
import { EricProcessingError, runEric, type EricConfiguration, type EricResult } from './eric'
import { ericXmlEvidence, retainEricQualificationEvidence } from './ericQualificationContract'
import { verifyEricRetainedPackage } from './ericRetainedPackage'

interface DiagnosticExpectation { namespace: string; localName: string; value: string }
export interface EricRetainedQualificationManifest {
  schemaVersion: 'ERIC_RETAINED_VALIDATION_V1'
  dataClassification: 'SYNTHETIC'
  retainedExportId: string
  archiveSha256: string
  repositoryCommit: string
  fixtureId: string
  fixtureVersion: string
  reportVersion: string
  sdkVersion: string
  runtime: { bridgeSha256: string; apiSha256: string; pluginSha256: string }
  /** Derived from the exact authorized SDK documentation, never guessed defaults. */
  diagnosticContractReference: string
  positiveDiagnostic: DiagnosticExpectation
  negativeDiagnostic: DiagnosticExpectation
  negativeStatusCode: number
}

export function retainedEricConfiguration(environment: NodeJS.ProcessEnv = process.env) {
  const value = (name: string) => environment[name]?.trim() ?? ''
  const enabled = value('ERIC_RETAINED_CONTRACT_ENABLED')
  if (!enabled || enabled === 'false') return null
  if (enabled !== 'true') throw new Error('ERIC_RETAINED_CONTRACT_ENABLED must be true or false.')
  if (value('ERIC_QUALIFICATION_AUTHORIZED_TEST_MODE') !== 'true') throw new Error('Explicit authorized validation-only test mode is required.')
  if (value('ERIC_QUALIFICATION_CERTIFICATE_PATH') || value('ERIC_QUALIFICATION_PIN')) throw new Error('Certificate and PIN inputs are forbidden for retained validation.')
  const requiredPath = (name: string) => {
    const result = value(name)
    if (!path.isAbsolute(result)) throw new Error(`${name} must be an absolute path.`)
    return result
  }
  const configuration: EricConfiguration = {
    bridgePath: requiredPath('ERIC_QUALIFICATION_BRIDGE_PATH'), runtimeDirectory: requiredPath('ERIC_QUALIFICATION_RUNTIME_DIR'),
    manufacturerId: value('ERIC_QUALIFICATION_MANUFACTURER_ID'), testMarker: value('ERIC_QUALIFICATION_TEST_MARKER'),
  }
  if (!/^\d+$/.test(configuration.manufacturerId) || !/^\d+$/.test(configuration.testMarker!)) throw new Error('Authorized numeric manufacturer identity and test marker are required.')
  const testTaxNumber = value('ERIC_QUALIFICATION_TEST_TAX_NUMBER')
  if (!/^\d{13}$/.test(testTaxNumber)) throw new Error('An authorized 13-digit test tax number is required.')
  return { configuration, testTaxNumber, packagePath: requiredPath('ERIC_RETAINED_PACKAGE_PATH'),
    manifestPath: requiredPath('ERIC_RETAINED_MANIFEST_PATH'), evidenceDirectory: requiredPath('ERIC_QUALIFICATION_EVIDENCE_DIR') }
}

export function validateEricRetainedManifest(manifest: EricRetainedQualificationManifest, repositoryCommit: string) {
  if (manifest?.schemaVersion !== 'ERIC_RETAINED_VALIDATION_V1') throw new Error('Retained ERiC manifest version is unsupported.')
  if (manifest.dataClassification !== 'SYNTHETIC') throw new Error('Explicit synthetic-data provenance is required.')
  if (!/^[a-f0-9]{40}$/.test(manifest.repositoryCommit) || manifest.repositoryCommit !== repositoryCommit) throw new Error('Qualification must run the exact manifest repository commit.')
  for (const digest of [manifest.archiveSha256, manifest.runtime?.bridgeSha256, manifest.runtime?.apiSha256, manifest.runtime?.pluginSha256]) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Pinned archive and runtime SHA-256 digests are required.')
  }
  for (const label of [manifest.retainedExportId, manifest.fixtureId, manifest.fixtureVersion, manifest.reportVersion, manifest.sdkVersion, manifest.diagnosticContractReference]) {
    if (typeof label !== 'string' || !label.trim()) throw new Error('Fixture, report, SDK and diagnostic contract identities are required.')
  }
  for (const diagnostic of [manifest.positiveDiagnostic, manifest.negativeDiagnostic]) {
    if (!diagnostic || typeof diagnostic.namespace !== 'string' || !diagnostic.namespace
      || typeof diagnostic.localName !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(diagnostic.localName)
      || typeof diagnostic.value !== 'string' || !diagnostic.value.trim()) throw new Error('Exact namespace-aware diagnostic expectations are required.')
  }
  if (canonicalJson(manifest.positiveDiagnostic) === canonicalJson(manifest.negativeDiagnostic)) throw new Error('Positive and negative diagnostics must be distinct.')
  if (!Number.isSafeInteger(manifest.negativeStatusCode) || manifest.negativeStatusCode <= 0) throw new Error('A documented positive integer content-rejection status is required.')
}

function matchesDiagnostic(xml: string, expected: DiagnosticExpectation) {
  try {
    return xmlDescendants(parseEBalanceXml(xml)).some(node => node.uri === expected.namespace && node.local === expected.localName
      && node.children.length === 0 && node.text.trim() === expected.value)
  } catch { return false }
}

/** Validation only. There is deliberately no submission or production-qualification write path. */
export async function runRetainedEricQualification(input: {
  manifest: EricRetainedQualificationManifest
  repositoryCommit: string
  archive: Uint8Array
  taxonomyArchive: Uint8Array
  configuration: EricConfiguration
  testTaxNumber: string
  evidenceDirectory: string
  authorizedValidationOnly: boolean
}, execute: typeof runEric = runEric) {
  const { manifest, configuration } = input
  validateEricRetainedManifest(manifest, input.repositoryCommit)
  if (input.authorizedValidationOnly !== true || configuration.certificatePath || !/^\d+$/.test(configuration.manufacturerId)
    || !/^\d+$/.test(configuration.testMarker ?? '') || !/^\d{13}$/.test(input.testTaxNumber)) throw new Error('Authorized validation-only configuration without a certificate is required.')
  if (![configuration.bridgePath, configuration.runtimeDirectory, input.evidenceDirectory].every(value => path.isAbsolute(value))) throw new Error('Runtime and evidence paths must be absolute.')
  const verified = verifyEricRetainedPackage(input.archive, manifest.archiveSha256, input.taxonomyArchive)
  if (verified.dataset.company.taxNumber !== input.testTaxNumber) throw new Error('Seed the authorized test identity before generating the retained package; identity substitution is forbidden.')
  const runtimePaths = { bridgeSha256: configuration.bridgePath, apiSha256: path.join(configuration.runtimeDirectory, 'ericapi.dll'),
    pluginSha256: path.join(configuration.runtimeDirectory, 'plugins', 'checkBilanz_6_9.dll') }
  const verifyRuntime = async () => {
    for (const [key, file] of Object.entries(runtimePaths)) {
      if (eBalanceChecksum(await readFile(file)) !== manifest.runtime[key as keyof typeof runtimePaths]) throw new Error('Runtime bytes differ from the pinned qualification identity.')
    }
  }
  await verifyRuntime()
  const manifestSha256 = eBalanceChecksum(canonicalJson(manifest))
  const qualificationId = eBalanceChecksum(canonicalJson({ manifestSha256, binding: verified.binding,
    manufacturer: eBalanceChecksum(configuration.manufacturerId), testMarker: eBalanceChecksum(configuration.testMarker!), testIdentity: eBalanceChecksum(input.testTaxNumber) }))
  const attempt = randomUUID()
  const privateDirectory = path.join(input.evidenceDirectory, 'private', attempt)
  await mkdir(privateDirectory, { recursive: true, mode: 0o700 })
  const retain = (name: string, bytes: string | Uint8Array) => writeFile(path.join(privateDirectory, name), bytes, { flag: 'wx', mode: 0o600 })
  await retain('export.zip', input.archive)
  await retain('export.xbrl', verified.exportXbrl)
  await retain('manifest.json', canonicalJson(manifest))
  const cases = []
  for (const [caseName, xbrl, expectedStatus, diagnostic] of [
    ['positive', verified.ericXbrl, 0, manifest.positiveDiagnostic],
    ['negative', verified.invalidXbrl, manifest.negativeStatusCode, manifest.negativeDiagnostic],
  ] as const) {
    const formattedEnvelope = createElsterEBalanceEnvelope(xbrl, {
      manufacturerId: configuration.manufacturerId, testMarker: configuration.testMarker,
      taxNumber: input.testTaxNumber, balanceSheetDate: verified.dataset.fiscalYear.endsAt,
      dataSupplier: 'Authorized synthetic qualification', clientVersion: 'Retained ERiC validation V1', ticket: qualificationId.slice(0, 20),
    })
    // The normal envelope formatter indents lines. Keep the instance body exact,
    // including newlines inside text facts, and remove only its XML declaration.
    const instance = xbrl.replace(/^<\?xml[^?]*\?>\r?\n/, '')
    const envelope = formattedEnvelope.replace(/<xbrli:xbrl[\s\S]*<\/xbrli:xbrl>/, () => instance)
    await retain(`${caseName}.xbrl`, xbrl)
    await retain(`${caseName}-envelope.xml`, envelope)
    let observed: EricResult | undefined
    let failureSha256: string | undefined
    let runtimeUnchanged = false
    let bridgeCompleted = false
    try {
      await verifyRuntime()
      try {
        observed = await execute(envelope, { send: false, configuration: { ...configuration, certificatePath: undefined } })
        bridgeCompleted = true
      } catch (error) {
        if (!(error instanceof EricProcessingError)) throw error
        observed = { statusCode: error.statusCode, statusText: error.message, sent: error.sent, resultXml: error.resultXml, serverResponseXml: error.serverResponseXml }
        bridgeCompleted = error.bridgeCompleted
      }
      await verifyRuntime()
      runtimeUnchanged = true
    } catch (error) {
      // Do not expose arbitrary bridge text, paths or taxpayer facts in test failures.
      failureSha256 = eBalanceChecksum(error instanceof Error ? error.message : String(error))
    }
    const diagnosticMatched = observed ? matchesDiagnostic(observed.resultXml, diagnostic) : false
    const passed = bridgeCompleted && runtimeUnchanged && !failureSha256 && observed?.statusCode === expectedStatus && observed.sent === false
      && observed.serverResponseXml.trim() === '' && diagnosticMatched
    if (observed) {
      await retain(`${caseName}-result.xml`, observed.resultXml)
      await retain(`${caseName}-server-response.xml`, observed.serverResponseXml)
    }
    const evidence = { schemaVersion: 'ERIC_RETAINED_VALIDATION_EVIDENCE_V1', authority: 'VALIDATION_ONLY_NOT_FINANZAMT_ACCEPTANCE',
      qualificationId, attempt, recordedAt: new Date().toISOString(), manifestSha256, repositoryCommit: input.repositoryCommit,
      case: caseName, passed, productionQualified: false, binding: verified.binding,
      runtime: { bridgeSha256: manifest.runtime.bridgeSha256, apiSha256: manifest.runtime.apiSha256, pluginSha256: manifest.runtime.pluginSha256 },
      sdkVersionSha256: eBalanceChecksum(manifest.sdkVersion), fixtureIdentitySha256: eBalanceChecksum(canonicalJson([manifest.fixtureId, manifest.fixtureVersion, manifest.reportVersion])),
      diagnosticContractSha256: eBalanceChecksum(manifest.diagnosticContractReference),
      request: { send: false, envelopeSha256: eBalanceChecksum(envelope), xbrlSha256: eBalanceChecksum(xbrl) },
      expected: { statusCode: expectedStatus, diagnosticSha256: eBalanceChecksum(canonicalJson(diagnostic)) },
      observed: observed ? { statusCode: observed.statusCode, sent: observed.sent, diagnosticMatched,
        statusTextSha256: eBalanceChecksum(observed.statusText), result: ericXmlEvidence(observed.resultXml), serverResponse: ericXmlEvidence(observed.serverResponseXml) } : null,
      runtimeUnchanged, bridgeCompleted, failureSha256 }
    // Retain both success and rejection evidence before any assertion ends the run.
    await retainEricQualificationEvidence(input.evidenceDirectory, `${attempt}-${caseName}.json`, evidence)
    cases.push(evidence)
  }
  return { qualificationId, passed: cases.every(result => result.passed), cases }
}
