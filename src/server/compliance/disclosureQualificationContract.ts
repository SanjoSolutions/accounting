import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { secureServiceEndpoint } from '../tax/transport'

export const qualifiedDisclosureCases = ['MICRO-HINTERLEGUNG', 'SMALL-OFFENLEGUNG'] as const
export type QualifiedDisclosureCase = typeof qualifiedDisclosureCases[number]

export interface QualifiedDisclosureContractConfig {
  enabled: boolean
  endpoint?: string
  credential?: string
  submitterId?: string
  gatewayId?: string
  qualificationId?: string
  schemaVersion?: string
  protocolDirectory?: string
  environment?: 'TEST' | 'STAGING'
  fixtureDirectory?: string
  fixtureManifestSha256?: string
  allowSubmission: boolean
  cases: readonly QualifiedDisclosureCase[]
}

const value = (environment: NodeJS.ProcessEnv, name: string) => environment[name]?.trim() ?? ''

export function qualifiedDisclosureContractConfiguration(environment: NodeJS.ProcessEnv = process.env): QualifiedDisclosureContractConfig {
  const enabledValue = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_ENABLED')
  if (enabledValue && !['true', 'false'].includes(enabledValue)) throw new Error('QUALIFIED_DISCLOSURE_CONTRACT_ENABLED must be true or false.')
  if (enabledValue !== 'true') return { enabled: false, allowSubmission: false, cases: [] }

  const endpoint = secureServiceEndpoint(value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_URL'), 'QUALIFIED_DISCLOSURE_CONTRACT_URL', false)
  const credential = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_CREDENTIAL')
  const submitterId = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_SUBMITTER_ID')
  const gatewayId = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_GATEWAY_ID')
  const qualificationId = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_QUALIFICATION_ID')
  const schemaVersion = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_SCHEMA_VERSION')
  const protocolDirectory = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_PROTOCOL_DIR')
  const targetEnvironment = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_ENVIRONMENT')
  const fixtureDirectory = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_FIXTURE_DIR')
  const fixtureManifestSha256 = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_FIXTURE_MANIFEST_SHA256')
  const allowSubmission = value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_ALLOW_SUBMISSION') === 'true'
  const cases = [...new Set(value(environment, 'QUALIFIED_DISCLOSURE_CONTRACT_CASES').split(',').map(item => item.trim()).filter(Boolean))].sort()
  const expectedCases = [...qualifiedDisclosureCases].sort()
  const issues = [
    ...(!credential || credential.length < 16 ? ['A disclosure contract credential of at least 16 characters is required.'] : []),
    ...(!submitterId ? ['An electronically identified authorized submitter is required.'] : []),
    ...(!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(gatewayId) ? ['A stable disclosure gateway identity is required.'] : []),
    ...(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(qualificationId) ? ['A retained disclosure qualification identity is required.'] : []),
    ...(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(schemaVersion) ? ['The exact provider-issued XML/XBRL schema version is required.'] : []),
    ...(!path.isAbsolute(protocolDirectory) ? ['The retained disclosure protocol directory must be an absolute path.'] : []),
    ...(!['TEST', 'STAGING'].includes(targetEnvironment) ? ['An exact TEST or STAGING environment is required before any request.'] : []),
    ...(!path.isAbsolute(fixtureDirectory) ? ['An absolute reviewed disclosure fixture directory is required.'] : []),
    ...(!/^[a-f0-9]{64}$/.test(fixtureManifestSha256) ? ['A protected SHA-256 pin for the reviewed fixture manifest is required.'] : []),
    ...(!allowSubmission ? ['QUALIFIED_DISCLOSURE_CONTRACT_ALLOW_SUBMISSION=true is required for acceptance evidence.'] : []),
    ...(JSON.stringify(cases) !== JSON.stringify(expectedCases) ? [`The exact supported disclosure cases are required: ${qualifiedDisclosureCases.join(',')}.`] : []),
  ]
  if (issues.length) throw new Error(issues.join(' '))
  const url = new URL(endpoint)
  if (url.search || url.hash) throw new Error('Disclosure contract endpoints must not contain query parameters or fragments.')
  return { enabled: true, endpoint, credential, submitterId, gatewayId, qualificationId, schemaVersion, protocolDirectory, environment: targetEnvironment as 'TEST' | 'STAGING', fixtureDirectory, fixtureManifestSha256, allowSubmission, cases: cases as QualifiedDisclosureCase[] }
}

const sensitiveKey = /(?:authorization|credential|token|secret|password|submitter|company|register|address|name|payload|dataset|xml|xbrl|receipt)/i
const retainedDigestKey = /^(?:request|response|receipt|submitter|package)Sha256$/
const sha256 = /^[a-f0-9]{64}$/

export function redactDisclosureProtocol(input: unknown, secrets: readonly string[] = []): unknown {
  if (Array.isArray(input)) return input.map(item => redactDisclosureProtocol(item, secrets))
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [
    key,
    retainedDigestKey.test(key) && typeof item === 'string' && sha256.test(item)
      ? item
      : sensitiveKey.test(key) ? '[REDACTED]' : redactDisclosureProtocol(item, secrets),
  ]))
  if (typeof input !== 'string') return input
  let redacted = input.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
  for (const secret of secrets.filter(Boolean)) redacted = redacted.replaceAll(secret, '[REDACTED]')
  return redacted
}

export function captureDisclosureRemoteResponse(bodyText: string, contentType: string | undefined, secrets: readonly string[] = []) {
  const bodySha256 = createHash('sha256').update(bodyText).digest('hex')
  const responseEvidence = { contentType: contentType?.split(';', 1)[0]?.trim().toLowerCase() || 'unknown', bodySha256, bodyLength: Buffer.byteLength(bodyText) }
  try {
    const parsed: unknown = JSON.parse(bodyText)
    return { parsed, evidence: responseEvidence }
  } catch {
    // Arbitrary provider text can echo identities, XML, or credentials under any key.
    // Retain fixity and media metadata, never a free-text excerpt.
    return { parsed: undefined, evidence: responseEvidence }
  }
}

export type QualifiedDisclosureStage = 'VALIDATED' | 'REJECTED' | 'ACCEPTED'

export interface QualifiedDisclosureProtocolExpectation {
  gatewayId: string
  qualificationId: string
  schemaVersion: string
  disclosureCase: QualifiedDisclosureCase
  stage: QualifiedDisclosureStage
  environment: 'TEST' | 'STAGING'
  submitterId: string
  sourcePackageChecksum: string
  packageSha256: string
  requestSha256: string
  fiscalYear: number
  receiptSha256?: string
}

export function assertQualifiedDisclosureProtocol(protocol: unknown, expected: QualifiedDisclosureProtocolExpectation) {
  if (!protocol || Array.isArray(protocol) || typeof protocol !== 'object') throw new Error('The disclosure gateway must return a machine-readable protocol object.')
  const item = protocol as Record<string, unknown>
  for (const field of ['gatewayId', 'qualificationId', 'schemaVersion', 'disclosureCase', 'stage'] as const) if (item[field] !== expected[field]) throw new Error('The disclosure protocol does not match the configured qualification, schema, case, or outcome.')
  if (typeof item.protocolId !== 'string' || !item.protocolId.trim()) throw new Error('The disclosure protocol requires a nonblank protocol identity.')
  if (typeof item.timestamp !== 'string' || !Number.isFinite(new Date(item.timestamp).getTime())) throw new Error('The disclosure protocol requires a valid timestamp.')
  if (!['TEST', 'STAGING'].includes(String(item.environment))) throw new Error('Disclosure qualification contracts are restricted to an explicit TEST or STAGING environment.')
  for (const field of ['environment', 'submitterId', 'sourcePackageChecksum', 'packageSha256', 'requestSha256', 'fiscalYear'] as const) if (item[field] !== expected[field]) throw new Error('The disclosure protocol does not match the submitted package, submitter, request, year, or environment.')
  for (const field of ['sourcePackageChecksum', 'packageSha256', 'requestSha256'] as const) if (!sha256.test(expected[field])) throw new Error('The disclosure protocol requires exact package and request checksums.')
  if (item.nonBinding !== true) throw new Error('The disclosure protocol must confirm non-binding delivery.')
  if (expected.stage === 'ACCEPTED' && (!expected.receiptSha256 || !sha256.test(expected.receiptSha256) || item.receiptSha256 !== expected.receiptSha256)) throw new Error('The disclosure protocol must identify the exact acceptance receipt.')
  if (item.destination !== 'UNTERNEHMENSREGISTER') throw new Error('The qualified destination must be the Unternehmensregister.')
  return item
}

/** Errors never echo remote bodies: providers may include private data in diagnostics. */
export function assertQualifiedDisclosureResponse(httpStatus: number, body: Record<string, unknown>, expected: Omit<QualifiedDisclosureProtocolExpectation, 'receiptSha256'>, previous?: { protocol: Record<string, unknown>; receiptSha256?: string }) {
  if (httpStatus !== 200 || !Array.isArray(body.errors)) throw new Error('The disclosure response has an unexpected HTTP status or error list.')
  if (expected.stage === 'REJECTED') {
    if (body.valid !== false || !body.errors.some(error => typeof error === 'string' && error.trim())) throw new Error('The invalid disclosure package must be rejected with a diagnostic.')
  } else if (expected.stage === 'VALIDATED') {
    if (body.valid !== true || body.errors.length) throw new Error('The valid disclosure package must pass provider validation.')
  } else if (body.outcome !== 'accepted' || body.errors.length || typeof body.receipt !== 'string' || !body.receipt.trim()) {
    throw new Error('The disclosure delivery must be accepted with a nonblank receipt.')
  }
  const receiptSha256 = typeof body.receipt === 'string' && body.receipt.trim() ? createHash('sha256').update(body.receipt).digest('hex') : undefined
  const protocol = assertQualifiedDisclosureProtocol(body.protocol, { ...expected, receiptSha256 })
  if (previous && (receiptSha256 !== previous.receiptSha256 || protocol.protocolId !== previous.protocol.protocolId)) throw new Error('Disclosure replay must return the original receipt and protocol identity.')
  return { protocol, receiptSha256 }
}

export function disclosureQualificationEvidence(args: {
  config: Required<Pick<QualifiedDisclosureContractConfig, 'gatewayId' | 'qualificationId' | 'schemaVersion' | 'environment' | 'submitterId'>>
  disclosureCase: QualifiedDisclosureCase
  fiscalYear: number
  caseName: string
  request: unknown
  httpStatus: number
  result: unknown
  protocol: unknown
  secrets?: readonly string[]
  binding: { manifestSha256: string; annualBundleSha256: string; manualBundleSha256: string; sourcePackageChecksum: string; packageSha256: string; adapterVersion: string }
  contractPassed: boolean
}) {
  const protocol = args.protocol && typeof args.protocol === 'object' ? args.protocol as Record<string, unknown> : {}
  // Only retain known protocol coordinates. Unknown keys and provider prose are private.
  const safeProtocol = Object.fromEntries(['protocolId', 'timestamp', 'gatewayId', 'qualificationId', 'schemaVersion', 'disclosureCase', 'stage', 'environment', 'destination', 'nonBinding', 'sourcePackageChecksum', 'packageSha256', 'requestSha256', 'fiscalYear', 'receiptSha256'].filter(key => ['string', 'number', 'boolean'].includes(typeof protocol[key])).map(key => [key, protocol[key]]))
  return {
    schema: 'qualified-unternehmensregister-contract-evidence', version: 2,
    recordedAt: new Date().toISOString(), case: args.caseName,
    gatewayId: args.config.gatewayId, qualificationId: args.config.qualificationId,
    schemaVersion: args.config.schemaVersion, disclosureCase: args.disclosureCase, fiscalYear: args.fiscalYear,
    environment: args.config.environment, nonBinding: true, contractPassed: args.contractPassed,
    submitterSha256: createHash('sha256').update(args.config.submitterId).digest('hex'),
    binding: args.binding,
    requestSha256: createHash('sha256').update(JSON.stringify(args.request)).digest('hex'),
    httpStatus: args.httpStatus,
    result: redactDisclosureProtocol(args.result, args.secrets),
    protocol: redactDisclosureProtocol(safeProtocol, args.secrets),
  }
}

export async function retainDisclosureQualificationEvidence(directory: string, fileName: string, evidence: unknown) {
  if (!path.isAbsolute(directory)) throw new Error('Disclosure qualification evidence directory must be absolute.')
  if (!/^[A-Za-z0-9._-]+\.json$/.test(fileName)) throw new Error('Disclosure qualification evidence filename is invalid.')
  await mkdir(directory, { recursive: true })
  const target = path.resolve(directory, fileName)
  if (path.dirname(target) !== path.resolve(directory)) throw new Error('Disclosure qualification evidence must remain inside its configured directory.')
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return target
}
