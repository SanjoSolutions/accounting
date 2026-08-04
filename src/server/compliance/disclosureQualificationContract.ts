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
    ...(!allowSubmission ? ['QUALIFIED_DISCLOSURE_CONTRACT_ALLOW_SUBMISSION=true is required for acceptance evidence.'] : []),
    ...(JSON.stringify(cases) !== JSON.stringify(expectedCases) ? [`The exact supported disclosure cases are required: ${qualifiedDisclosureCases.join(',')}.`] : []),
  ]
  if (issues.length) throw new Error(issues.join(' '))
  return { enabled: true, endpoint, credential, submitterId, gatewayId, qualificationId, schemaVersion, protocolDirectory, allowSubmission, cases: cases as QualifiedDisclosureCase[] }
}

const sensitiveKey = /(?:authorization|credential|token|secret|password|submitter|company|register|address|name|payload|dataset|xml|xbrl|receipt)/i

export function redactDisclosureProtocol(input: unknown, secrets: readonly string[] = []): unknown {
  if (Array.isArray(input)) return input.map(item => redactDisclosureProtocol(item, secrets))
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redactDisclosureProtocol(item, secrets)]))
  if (typeof input !== 'string') return input
  let redacted = input.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
  for (const secret of secrets.filter(Boolean)) redacted = redacted.replaceAll(secret, '[REDACTED]')
  return redacted
}

export type QualifiedDisclosureStage = 'VALIDATED' | 'REJECTED' | 'ACCEPTED'

export function assertQualifiedDisclosureProtocol(protocol: unknown, expected: {
  gatewayId: string
  qualificationId: string
  schemaVersion: string
  disclosureCase: QualifiedDisclosureCase
  stage: QualifiedDisclosureStage
}) {
  if (!protocol || Array.isArray(protocol) || typeof protocol !== 'object') throw new Error('The disclosure gateway must return a machine-readable protocol object.')
  const item = protocol as Record<string, unknown>
  for (const field of ['gatewayId', 'qualificationId', 'schemaVersion', 'disclosureCase', 'stage'] as const) if (item[field] !== expected[field]) throw new Error('The disclosure protocol does not match the configured qualification, schema, case, or outcome.')
  if (typeof item.protocolId !== 'string' || !item.protocolId.trim()) throw new Error('The disclosure protocol requires a nonblank protocol identity.')
  if (typeof item.timestamp !== 'string' || !Number.isFinite(new Date(item.timestamp).getTime())) throw new Error('The disclosure protocol requires a valid timestamp.')
  if (!['TEST', 'STAGING'].includes(String(item.environment))) throw new Error('Disclosure qualification contracts are restricted to an explicit TEST or STAGING environment.')
  if (item.destination !== 'UNTERNEHMENSREGISTER') throw new Error('The qualified destination must be the Unternehmensregister.')
  return item
}

export function disclosureQualificationEvidence(args: {
  config: Required<Pick<QualifiedDisclosureContractConfig, 'gatewayId' | 'qualificationId' | 'schemaVersion'>>
  disclosureCase: QualifiedDisclosureCase
  fiscalYear: number
  caseName: string
  request: unknown
  httpStatus: number
  result: unknown
  protocol: unknown
  secrets?: readonly string[]
}) {
  return {
    schema: 'qualified-unternehmensregister-contract-evidence', version: 1,
    recordedAt: new Date().toISOString(), case: args.caseName,
    gatewayId: args.config.gatewayId, qualificationId: args.config.qualificationId,
    schemaVersion: args.config.schemaVersion, disclosureCase: args.disclosureCase, fiscalYear: args.fiscalYear,
    requestSha256: createHash('sha256').update(JSON.stringify(args.request)).digest('hex'),
    httpStatus: args.httpStatus,
    result: redactDisclosureProtocol(args.result, args.secrets),
    protocol: redactDisclosureProtocol(args.protocol, args.secrets),
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
