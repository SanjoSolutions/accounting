import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import {
  assertQualifiedDisclosureProtocol, disclosureQualificationEvidence, qualifiedDisclosureCases,
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
    const dataset = syntheticDataset(disclosureCase)
    const context = await playwright.request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } })
    const retain = async (caseName: string, request: unknown, response: { status: number; body: any }, stage: 'VALIDATED' | 'REJECTED' | 'ACCEPTED', result: unknown) => {
      await retainDisclosureQualificationEvidence(configuration.protocolDirectory!, `${evidenceRunId}-${disclosureCase.toLowerCase()}-${caseName}.json`, disclosureQualificationEvidence({
        config: { gatewayId: configuration.gatewayId!, qualificationId: configuration.qualificationId!, schemaVersion: configuration.schemaVersion! },
        disclosureCase, fiscalYear: dataset.fiscalYear, caseName, request, httpStatus: response.status, result, protocol: response.body.protocol,
        secrets: [credential, configuration.submitterId!],
      }))
      return assertQualifiedDisclosureProtocol(response.body.protocol, { gatewayId: configuration.gatewayId!, qualificationId: configuration.qualificationId!, schemaVersion: configuration.schemaVersion!, disclosureCase, stage })
    }

    try {
      const validationRequest = { dataset }
      const validationResponse = await context.post(`${endpoint}/validate`, { data: validationRequest })
      const validationBody = await validationResponse.json()
      await retain('validation', validationRequest, { status: validationResponse.status(), body: validationBody }, 'VALIDATED', validationBody)
      expect(validationResponse.status()).toBe(200)
      expect(validationBody).toMatchObject({ valid: true, errors: [] })

      const rejectionRequest = { dataset: { ...dataset, company: { ...dataset.company, registerNumber: '' } } }
      const rejectionResponse = await context.post(`${endpoint}/validate`, { data: rejectionRequest })
      const rejectionBody = await rejectionResponse.json()
      await retain('rejection', rejectionRequest, { status: rejectionResponse.status(), body: rejectionBody }, 'REJECTED', rejectionBody)
      expect(rejectionResponse.status()).toBe(200)
      expect(rejectionBody.valid).toBe(false)
      expect(rejectionBody.errors).toEqual(expect.arrayContaining([expect.any(String)]))

      const submissionRequest = { dataset, idempotencyKey: createHash('sha256').update(`qualified-disclosure:${disclosureCase}:${dataset.fiscalYear}`).digest('hex') }
      const submissionResponse = await context.post(`${endpoint}/submit`, { data: submissionRequest })
      const submissionBody = await submissionResponse.json()
      const receiptSha256 = typeof submissionBody.receipt === 'string' ? createHash('sha256').update(submissionBody.receipt).digest('hex') : null
      await retain('acceptance', submissionRequest, { status: submissionResponse.status(), body: submissionBody }, 'ACCEPTED', { ...submissionBody, receiptSha256 })
      expect(submissionResponse.status()).toBe(200)
      expect(submissionBody).toMatchObject({ outcome: 'accepted', errors: [], receipt: expect.any(String) })
      expect(submissionBody.receipt.trim()).not.toBe('')
    } finally { await context.dispose() }
  })
})
