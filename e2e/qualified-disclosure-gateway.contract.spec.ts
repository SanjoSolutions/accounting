import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  assertQualifiedDisclosureProtocol, captureDisclosureRemoteResponse, disclosureQualificationEvidence, qualifiedDisclosureCases,
  qualifiedDisclosureContractConfiguration, retainDisclosureQualificationEvidence, type QualifiedDisclosureCase,
} from '../src/server/compliance/disclosureQualificationContract'

const configuration = qualifiedDisclosureContractConfiguration()
const evidenceRunId = (process.env.GITHUB_RUN_ID?.trim() || `${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '-')

function syntheticDataset(disclosureCase: QualifiedDisclosureCase) {
  const micro = disclosureCase === 'MICRO-HINTERLEGUNG'
  return {
    destination: 'UNTERNEHMENSREGISTER', disclosureCase, fiscalYear: 2026,
    schemaVersion: configuration.schemaVersion, submitterId: configuration.submitterId,
    company: { legalName: 'Qualification Testgesellschaft GmbH', legalForm: micro ? 'UG (haftungsbeschränkt)' : 'GmbH', registerCourt: 'Amtsgericht Teststadt', registerNumber: 'HRB 12345', registeredOffice: 'Teststadt' },
    period: { start: '2026-01-01', end: '2026-12-31' }, currency: 'EUR', language: 'de',
    statements: {
      balanceSheet: [{ code: 'A.ASSETS', amountCents: 10_000 }, { code: 'B.EQUITY_LIABILITIES', amountCents: 10_000 }],
      incomeStatement: [{ code: 'NET_INCOME', amountCents: 0 }],
      notes: micro ? ['Required below-balance-sheet disclosures assessed.'] : ['Synthetic qualification notes.'],
    },
  }
}

test.describe('qualified Unternehmensregister gateway interoperability contract', () => {
  test.skip(!configuration.enabled, 'No authorized Unternehmensregister Webservice gateway was explicitly configured. This skip is not qualification or filing evidence.')

  for (const disclosureCase of qualifiedDisclosureCases) test(`${disclosureCase} validates, rejects incomplete identity, and returns staging acceptance evidence`, async ({ playwright }) => {
    const endpoint = configuration.endpoint!
    const credential = configuration.credential!
    const secrets = [credential, configuration.submitterId!]
    const dataset = syntheticDataset(disclosureCase)
    const context = await playwright.request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } })
    const capture = async (response: { status(): number; text(): Promise<string>; headers(): Record<string, string> }) => {
      const captured = captureDisclosureRemoteResponse(await response.text(), response.headers()['content-type'], secrets)
      const body = captured.parsed && typeof captured.parsed === 'object' && !Array.isArray(captured.parsed) ? captured.parsed as Record<string, any> : undefined
      return { status: response.status(), body, evidence: captured.evidence }
    }
    const retain = async (caseName: string, request: unknown, response: Awaited<ReturnType<typeof capture>>, stage: 'VALIDATED' | 'REJECTED' | 'ACCEPTED', result: unknown) => {
      await retainDisclosureQualificationEvidence(configuration.protocolDirectory!, `${evidenceRunId}-${disclosureCase.toLowerCase()}-${caseName}.json`, disclosureQualificationEvidence({
        config: { gatewayId: configuration.gatewayId!, qualificationId: configuration.qualificationId!, schemaVersion: configuration.schemaVersion! },
        disclosureCase, fiscalYear: dataset.fiscalYear, caseName, request, httpStatus: response.status, result: { response: response.evidence, contractResult: result }, protocol: response.body?.protocol,
        secrets,
      }))
      return assertQualifiedDisclosureProtocol(response.body?.protocol, { gatewayId: configuration.gatewayId!, qualificationId: configuration.qualificationId!, schemaVersion: configuration.schemaVersion!, disclosureCase, stage })
    }

    try {
      const validationRequest = { dataset }
      const validationResponse = await context.post(`${endpoint}/validate`, { data: validationRequest }); const validation = await capture(validationResponse); const validationBody = validation.body
      await retain('validation', validationRequest, validation, 'VALIDATED', validationBody)
      expect(validation.status).toBe(200)
      expect(validationBody).toMatchObject({ valid: true, errors: [] })

      const rejectionRequest = { dataset: { ...dataset, company: { ...dataset.company, registerNumber: '' } } }
      const rejectionResponse = await context.post(`${endpoint}/validate`, { data: rejectionRequest }); const rejection = await capture(rejectionResponse); const rejectionBody = rejection.body ?? {}
      await retain('rejection', rejectionRequest, rejection, 'REJECTED', rejectionBody)
      expect(rejection.status).toBe(200)
      expect(rejectionBody.valid).toBe(false)
      expect(rejectionBody.errors).toEqual(expect.arrayContaining([expect.any(String)]))

      const submissionRequest = { dataset, idempotencyKey: createHash('sha256').update(`qualified-disclosure:${disclosureCase}:${dataset.fiscalYear}`).digest('hex') }
      const submissionResponse = await context.post(`${endpoint}/submit`, { data: submissionRequest }); const submission = await capture(submissionResponse); const submissionBody = submission.body ?? {}
      const receiptSha256 = typeof submissionBody.receipt === 'string' ? createHash('sha256').update(submissionBody.receipt).digest('hex') : null
      const acceptedProtocol = await retain('acceptance', submissionRequest, submission, 'ACCEPTED', { ...submissionBody, receiptSha256 })
      expect(submission.status).toBe(200)
      expect(submissionBody).toMatchObject({ outcome: 'accepted', errors: [], receipt: expect.any(String) })
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
