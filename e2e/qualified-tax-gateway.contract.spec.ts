import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { taxFormRegistry, type DeclarationDataset } from '../src/core/taxDeclarations'
import {
  assertQualifiedGatewayProtocol, captureQualificationRemoteResponse, qualificationEvidence, qualifiedGatewayContractConfiguration, retainQualificationEvidence,
} from '../src/server/tax/qualificationContract'

const configuration = qualifiedGatewayContractConfiguration()
const evidenceRunId = (process.env.GITHUB_RUN_ID?.trim() || `${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '-')
const taxpayerId = configuration.taxpayerId ?? 'disabled-contract'

const datasets: DeclarationDataset[] = [
  taxFormRegistry.prepare('USTVA', '2025-01', { ZAHLLAST: 1_900 }, { ZAHLLAST: ['synthetic-vat-contract-evidence'] }, taxpayerId),
  taxFormRegistry.prepare('UST_ANNUAL', '2025', { ZAHLLAST: 22_800 }, { ZAHLLAST: ['synthetic-annual-vat-contract-evidence'] }, taxpayerId),
  taxFormRegistry.prepare('KST', '2025', { STEUERLICHES_ERGEBNIS: 10_100_000 }, { STEUERLICHES_ERGEBNIS: ['synthetic-hgb-close-contract-evidence'] }, taxpayerId),
  taxFormRegistry.prepare('GEWST', '2025', { GEWERBEERTRAG: 10_100_000, GEMEINDE: '11000000', HEBESATZ_BP: 41_000 }, { GEWERBEERTRAG: ['synthetic-hgb-close-contract-evidence'] }, taxpayerId),
  taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1_900 }, { ZAHLLAST: ['synthetic-vat-contract-evidence'] }, taxpayerId),
  taxFormRegistry.prepare('UST_ANNUAL', '2026', { ZAHLLAST: 22_800 }, { ZAHLLAST: ['synthetic-annual-vat-contract-evidence'] }, taxpayerId),
  taxFormRegistry.prepare('KST', '2026', { STEUERLICHES_ERGEBNIS: 10_100_000, KST_SCHULD: 1_515_000 }, { STEUERLICHES_ERGEBNIS: ['synthetic-hgb-close-contract-evidence'] }, taxpayerId),
  taxFormRegistry.prepare('GEWST', '2026', { GEWERBEERTRAG: 10_100_000, GEWST_SCHULD: 1_449_350, GEMEINDE: '11000000', HEBESATZ_BP: 41_000 }, { GEWERBEERTRAG: ['synthetic-hgb-close-contract-evidence'] }, taxpayerId),
]

test.describe('qualified ELSTER gateway interoperability contract', () => {
  test.skip(!configuration.enabled, 'No authorized qualified gateway was explicitly configured. This skip is not interoperability or ELSTER qualification evidence.')

  for (const dataset of datasets) test(`${dataset.formVersion} validates, rejects malformed facts, and returns staging acceptance evidence`, async ({ playwright }) => {
    const endpoint = configuration.endpoint!
    const credential = configuration.credential!
    const secrets = [credential, taxpayerId]
    const context = await playwright.request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } })
    const capture = async (response: { status(): number; text(): Promise<string>; headers(): Record<string, string> }) => {
      const captured = captureQualificationRemoteResponse(await response.text(), response.headers()['content-type'], secrets)
      const body = captured.parsed && typeof captured.parsed === 'object' && !Array.isArray(captured.parsed) ? captured.parsed as Record<string, any> : undefined
      return { status: response.status(), body, evidence: captured.evidence }
    }
    const retain = async (caseName: string, request: unknown, response: Awaited<ReturnType<typeof capture>>, stage: 'VALIDATED' | 'REJECTED' | 'ACCEPTED', result: unknown) => {
      await retainQualificationEvidence(configuration.protocolDirectory!, `${evidenceRunId}-${dataset.formVersion.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}-${caseName}.json`, qualificationEvidence({
        config: { gatewayId: configuration.gatewayId!, qualificationId: configuration.qualificationId! },
        dataset, caseName, request, httpStatus: response.status, result: { response: response.evidence, contractResult: result }, protocol: response.body?.protocol, secrets,
      }))
      return assertQualifiedGatewayProtocol(response.body?.protocol, {
        gatewayId: configuration.gatewayId!, qualificationId: configuration.qualificationId!, formVersion: dataset.formVersion, stage,
      })
    }

    try {
      const validationRequest = { dataset }
      const validationResponse = await context.post(`${endpoint}/validate`, { data: validationRequest }); const validation = await capture(validationResponse); const validationBody = validation.body
      await retain('validation', validationRequest, validation, 'VALIDATED', validationBody)
      expect(validation.status).toBe(200)
      expect(validationBody).toMatchObject({ valid: true, errors: [] })

      const requiredField = Object.keys(dataset.fields)[0]
      const invalidDataset = { ...dataset, fields: Object.fromEntries(Object.entries(dataset.fields).filter(([field]) => field !== requiredField)) }
      const rejectionRequest = { dataset: invalidDataset }
      const rejectionResponse = await context.post(`${endpoint}/validate`, { data: rejectionRequest }); const rejection = await capture(rejectionResponse); const rejectionBody = rejection.body ?? {}
      await retain('rejection', rejectionRequest, rejection, 'REJECTED', rejectionBody)
      expect(rejection.status).toBe(200)
      expect(rejectionBody.valid).toBe(false)
      expect(rejectionBody.errors).toEqual(expect.arrayContaining([expect.any(String)]))
      expect(rejectionBody.errors.every((error: unknown) => typeof error === 'string' && error.trim())).toBe(true)

      const submissionRequest = { dataset, idempotencyKey: createHash('sha256').update(`qualified-contract:${dataset.kind}:${dataset.period}`).digest('hex') }
      const submissionResponse = await context.post(`${endpoint}/submit`, { data: submissionRequest }); const submission = await capture(submissionResponse); const submissionBody = submission.body ?? {}
      const receiptSha256 = typeof submissionBody.receipt === 'string' ? createHash('sha256').update(submissionBody.receipt).digest('hex') : null
      const acceptedProtocol = await retain('acceptance', submissionRequest, submission, 'ACCEPTED', { ...submissionBody, receiptSha256 })
      expect(submission.status).toBe(200)
      expect(submissionBody.outcome).toBe('accepted')
      expect(submissionBody.errors ?? []).toEqual([])
      expect(submissionBody.receipt).toEqual(expect.any(String))
      expect(submissionBody.receipt.trim()).not.toBe('')

      const replayResponse = await context.post(`${endpoint}/submit`, { data: submissionRequest }); const replay = await capture(replayResponse); const replayBody = replay.body
      const replayReceiptSha256 = typeof replayBody?.receipt === 'string' ? createHash('sha256').update(replayBody.receipt).digest('hex') : null
      const replayProtocol = await retain('acceptance-replay', submissionRequest, replay, 'ACCEPTED', { ...replayBody, receiptSha256: replayReceiptSha256 })
      expect(replay.status).toBe(200)
      expect(replayBody).toMatchObject({ outcome: 'accepted', errors: [], receipt: expect.any(String) })
      expect(replayReceiptSha256).toBe(receiptSha256)
      expect(replayProtocol.protocolId).toBe(acceptedProtocol.protocolId)
    } finally { await context.dispose() }
  })
})
