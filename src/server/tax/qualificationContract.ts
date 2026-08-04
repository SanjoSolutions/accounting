import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { secureServiceEndpoint } from './transport'

export const qualifiedContractFormVersions = [
  'USTVA-2025.1', 'UST_ANNUAL-2025.1', 'KST-2025.1', 'GEWST-2025.1',
  'USTVA-2026.1', 'UST_ANNUAL-2026.1', 'KST-2026.1', 'GEWST-2026.1',
] as const

export interface QualifiedGatewayContractConfig {
  enabled: boolean
  endpoint?: string
  credential?: string
  taxpayerId?: string
  gatewayId?: string
  qualificationId?: string
  protocolDirectory?: string
  allowSubmission: boolean
  qualifiedFormVersions: readonly string[]
}

const value = (environment: NodeJS.ProcessEnv, name: string) => environment[name]?.trim() ?? ''

export function qualifiedGatewayContractConfiguration(environment: NodeJS.ProcessEnv = process.env): QualifiedGatewayContractConfig {
  const enabledValue = value(environment, 'QUALIFIED_TAX_GATEWAY_CONTRACT_ENABLED')
  if (enabledValue && !['true', 'false'].includes(enabledValue)) throw new Error('QUALIFIED_TAX_GATEWAY_CONTRACT_ENABLED must be true or false.')
  if (enabledValue !== 'true') return { enabled: false, allowSubmission: false, qualifiedFormVersions: [] }

  const endpoint = secureServiceEndpoint(value(environment, 'QUALIFIED_TAX_GATEWAY_CONTRACT_URL'), 'QUALIFIED_TAX_GATEWAY_CONTRACT_URL', false)
  const credential = value(environment, 'QUALIFIED_TAX_GATEWAY_CONTRACT_CREDENTIAL')
  const taxpayerId = value(environment, 'QUALIFIED_TAX_GATEWAY_CONTRACT_TAXPAYER_ID')
  const gatewayId = value(environment, 'QUALIFIED_TAX_GATEWAY_CONTRACT_GATEWAY_ID')
  const qualificationId = value(environment, 'QUALIFIED_TAX_GATEWAY_CONTRACT_QUALIFICATION_ID')
  const protocolDirectory = value(environment, 'QUALIFIED_TAX_GATEWAY_CONTRACT_PROTOCOL_DIR')
  const allowSubmission = value(environment, 'QUALIFIED_TAX_GATEWAY_CONTRACT_ALLOW_SUBMISSION') === 'true'
  const qualifiedFormVersions = [...new Set(value(environment, 'QUALIFIED_TAX_GATEWAY_CONTRACT_FORM_VERSIONS').split(',').map(item => item.trim()).filter(Boolean))].sort()
  const issues = [
    ...(!credential || credential.length < 16 ? ['A contract credential of at least 16 characters is required.'] : []),
    ...(!taxpayerId ? ['An authorized test taxpayer identity is required.'] : []),
    ...(!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(gatewayId) ? ['A stable gateway identity is required.'] : []),
    ...(!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/.test(qualificationId) ? ['A retained qualification record identity is required.'] : []),
    ...(!path.isAbsolute(protocolDirectory) ? ['The retained protocol directory must be an absolute path.'] : []),
    ...(!allowSubmission ? ['QUALIFIED_TAX_GATEWAY_CONTRACT_ALLOW_SUBMISSION=true is required for acceptance evidence.'] : []),
    ...(JSON.stringify(qualifiedFormVersions) !== JSON.stringify([...qualifiedContractFormVersions].sort()) ? [`The exact supported contract form versions are required: ${qualifiedContractFormVersions.join(',')}.`] : []),
  ]
  if (issues.length) throw new Error(issues.join(' '))
  return { enabled: true, endpoint, credential, taxpayerId, gatewayId, qualificationId, protocolDirectory, allowSubmission, qualifiedFormVersions }
}

const sensitiveKey = /(?:authorization|credential|token|secret|password|pin|certificate|taxpayer|steuernummer|taxnumber|iban|street|address|name|payload|dataset|xml|receipt)/i

export function redactQualificationProtocol(input: unknown, secrets: readonly string[] = []): unknown {
  if (Array.isArray(input)) return input.map(item => redactQualificationProtocol(item, secrets))
  if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redactQualificationProtocol(item, secrets)]))
  if (typeof input !== 'string') return input
  let redacted = input.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/<(Steuernummer|taxpayerId|iban|Pin)>[\s\S]*?<\/\1>/gi, '<$1>[REDACTED]</$1>')
  for (const secret of secrets.filter(Boolean)) redacted = redacted.replaceAll(secret, '[REDACTED]')
  return redacted
}

export type QualifiedProtocolStage = 'VALIDATED' | 'REJECTED' | 'ACCEPTED'

export function assertQualifiedGatewayProtocol(protocol: unknown, expected: { gatewayId: string; qualificationId: string; formVersion: string; stage: QualifiedProtocolStage }) {
  if (!protocol || Array.isArray(protocol) || typeof protocol !== 'object') throw new Error('The qualified gateway must return a machine-readable protocol object.')
  const value = protocol as Record<string, unknown>
  if (value.gatewayId !== expected.gatewayId || value.qualificationId !== expected.qualificationId || value.formVersion !== expected.formVersion || value.stage !== expected.stage) throw new Error('The gateway protocol does not match the configured qualification, form version, or outcome.')
  if (typeof value.protocolId !== 'string' || !value.protocolId.trim()) throw new Error('The gateway protocol requires a nonblank protocol identity.')
  if (typeof value.timestamp !== 'string' || !Number.isFinite(new Date(value.timestamp).getTime())) throw new Error('The gateway protocol requires a valid timestamp.')
  if (!['TEST', 'STAGING'].includes(String(value.environment))) throw new Error('Qualification contracts are restricted to an explicit TEST or STAGING environment.')
  return value
}

export function qualificationEvidence(args: {
  config: Required<Pick<QualifiedGatewayContractConfig, 'gatewayId' | 'qualificationId'>>
  dataset: { kind: string; period: string; formVersion: string }
  caseName: string
  request: unknown
  httpStatus: number
  result: unknown
  protocol: unknown
  secrets?: readonly string[]
}) {
  return {
    schema: 'qualified-tax-gateway-contract-evidence', version: 1,
    recordedAt: new Date().toISOString(), case: args.caseName,
    gatewayId: args.config.gatewayId, qualificationId: args.config.qualificationId,
    declaration: { kind: args.dataset.kind, period: args.dataset.period, formVersion: args.dataset.formVersion },
    requestSha256: createHash('sha256').update(JSON.stringify(args.request)).digest('hex'),
    httpStatus: args.httpStatus,
    result: redactQualificationProtocol(args.result, args.secrets),
    protocol: redactQualificationProtocol(args.protocol, args.secrets),
  }
}

export async function retainQualificationEvidence(directory: string, fileName: string, evidence: unknown) {
  if (!path.isAbsolute(directory)) throw new Error('Qualification evidence directory must be absolute.')
  if (!/^[A-Za-z0-9._-]+\.json$/.test(fileName)) throw new Error('Qualification evidence filename is invalid.')
  await mkdir(directory, { recursive: true })
  const target = path.resolve(directory, fileName)
  if (path.dirname(target) !== path.resolve(directory)) throw new Error('Qualification evidence must remain inside its configured directory.')
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return target
}
