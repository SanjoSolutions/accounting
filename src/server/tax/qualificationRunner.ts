import { taxFormRegistry } from '../../core/taxDeclarations'
import { qualificationSha256, qualificationSubmissionKey, type QualifiedTaxArtifact } from './qualificationArtifacts'
import { assertQualifiedGatewayProtocol, qualificationEvidence, redactQualificationProtocol, type QualifiedGatewayContractConfig, type QualifiedProtocolStage } from './qualificationContract'

export interface QualificationResponse { status: number; body: string; contentType?: string }
type ContractConfig = Required<Pick<QualifiedGatewayContractConfig, 'gatewayId' | 'qualificationId' | 'environment' | 'credential' | 'taxpayerId'>>

function requireOutcome(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const protocolFields = ['gatewayId', 'qualificationId', 'formVersion', 'stage', 'protocolId', 'timestamp', 'environment', 'requestSha256'] as const

// Transport is injected so the full fail-closed sequence can be tested offline.
// Raw remote payloads and transport exceptions must never reach test reporters.
export async function executeQualifiedTaxContract(artifact: QualifiedTaxArtifact, config: ContractConfig, io: {
  post: (action: 'validate' | 'submit', body: string) => Promise<QualificationResponse>
  retain: (caseName: string, evidence: unknown) => Promise<void>
}) {
  const { dataset } = artifact
  const secrets = [config.credential, config.taxpayerId]
  const exchange = async (caseName: string, action: 'validate' | 'submit', request: Record<string, unknown>, stage: QualifiedProtocolStage, check: (body: Record<string, unknown>, protocol: Record<string, unknown>) => void) => {
    const body = JSON.stringify(request)
    let response: QualificationResponse
    try { response = await io.post(action, body) }
    catch {
      await io.retain(caseName, { ...qualificationEvidence({ config, dataset, caseName, request, httpStatus: 0, result: { transportError: true }, protocol: null, artifact: artifact.binding }), checksPassed: false })
      throw new Error('The qualification transport failed; recover using the same reviewed artifact and configuration. No acceptance is established.')
    }
    let parsed: Record<string, unknown> | undefined
    try { parsed = object(JSON.parse(response.body)) } catch { /* retain only fixity, never remote text */ }
    const protocol = object(parsed?.protocol)
    const safeProtocol = protocol ? Object.fromEntries(protocolFields.map(key => [key, typeof protocol[key] === 'string' ? String(protocol[key]).slice(0, 512) : null])) : null
    const result = {
      responseSha256: qualificationSha256(response.body), bodyLength: Buffer.byteLength(response.body),
      jsonObject: Boolean(parsed), receiptSha256: typeof parsed?.receipt === 'string' ? qualificationSha256(parsed.receipt) : null,
      errorCount: Array.isArray(parsed?.errors) ? parsed.errors.length : null,
    }
    const evidence = qualificationEvidence({ config, dataset, caseName, request, httpStatus: response.status, result, protocol: safeProtocol, secrets, artifact: artifact.binding })
    try {
      requireOutcome(response.status === 200 && parsed, 'The qualification gateway must return HTTP 200 and a JSON object.')
      const verified = assertQualifiedGatewayProtocol(protocol, { ...config, formVersion: dataset.formVersion, stage, requestSha256: qualificationSha256(body) })
      check(parsed, verified)
    } catch (error) {
      await io.retain(caseName, { ...evidence, checksPassed: false })
      throw error
    }
    await io.retain(caseName, { ...evidence, checksPassed: true })
    return { body: parsed!, protocol: protocol! }
  }
  // Explicit non-production selection is present in the hashed wire request.
  const validationRequest = { environment: config.environment, dataset }
  await exchange('validation', 'validate', validationRequest, 'VALIDATED', body => {
    requireOutcome(body.valid === true && Array.isArray(body.errors) && body.errors.length === 0, 'The retained dataset must validate without errors.')
  })
  const requiredField = taxFormRegistry.resolve(dataset.kind, dataset.period).requiredFields[0]
  const invalidDataset = { ...dataset, fields: Object.fromEntries(Object.entries(dataset.fields).filter(([key]) => key !== requiredField)) }
  await exchange('rejection', 'validate', { environment: config.environment, dataset: invalidDataset }, 'REJECTED', body => {
    requireOutcome(body.valid === false && Array.isArray(body.errors) && body.errors.length > 0 && body.errors.every(error => typeof error === 'string' && error.trim()), 'The invalid dataset must be rejected with nonblank errors.')
  })
  const submissionRequest = { environment: config.environment, dataset, idempotencyKey: qualificationSubmissionKey(artifact, config) }
  const accepted = (body: Record<string, unknown>) => {
    requireOutcome(body.outcome === 'accepted' && Array.isArray(body.errors) && body.errors.length === 0 && typeof body.receipt === 'string' && body.receipt.trim(), 'The submission must be accepted without errors and carry a nonblank receipt.')
  }
  const original = await exchange('acceptance', 'submit', submissionRequest, 'ACCEPTED', accepted)
  await exchange('acceptance-replay', 'submit', submissionRequest, 'ACCEPTED', (body, protocol) => {
    accepted(body)
    requireOutcome(protocol.protocolId === original.protocol.protocolId && body.receipt === original.body.receipt, 'The replay must return the original protocol identity and exact receipt.')
  })
  return redactQualificationProtocol({ formVersion: dataset.formVersion, ...artifact.binding, accepted: true }, secrets)
}
