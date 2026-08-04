import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { taxFormRegistry, type DeclarationDataset } from '../src/core/taxDeclarations'
import {
  assertQualifiedGatewayProtocol, qualificationEvidence, qualifiedGatewayContractConfiguration, retainQualificationEvidence,
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
    const context = await playwright.request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' } })
    const retain = async (caseName: string, request: unknown, response: { status: number; body: any }, stage: 'VALIDATED' | 'REJECTED' | 'ACCEPTED', result: unknown) => {
      await retainQualificationEvidence(configuration.protocolDirectory!, `${evidenceRunId}-${dataset.kind.toLowerCase()}-${caseName}.json`, qualificationEvidence({
        config: { gatewayId: configuration.gatewayId!, qualificationId: configuration.qualificationId! },
        dataset, caseName, request, httpStatus: response.status, result, protocol: response.body.protocol, secrets: [credential, taxpayerId],
      }))
      return assertQualifiedGatewayProtocol(response.body.protocol, {
        gatewayId: configuration.gatewayId!, qualificationId: configuration.qualificationId!, formVersion: dataset.formVersion, stage,
      })
    }

    try {
      const validationRequest = { dataset }
      const validationResponse = await context.post(`${endpoint}/validate`, { data: validationRequest })
      const validationBody = await validationResponse.json()
      await retain('validation', validationRequest, { status: validationResponse.status(), body: validationBody }, 'VALIDATED', validationBody)
      expect(validationResponse.status()).toBe(200)
      expect(validationBody).toMatchObject({ valid: true, errors: [] })

      const requiredField = Object.keys(dataset.fields)[0]
      const invalidDataset = { ...dataset, fields: Object.fromEntries(Object.entries(dataset.fields).filter(([field]) => field !== requiredField)) }
      const rejectionRequest = { dataset: invalidDataset }
      const rejectionResponse = await context.post(`${endpoint}/validate`, { data: rejectionRequest })
      const rejectionBody = await rejectionResponse.json()
      await retain('rejection', rejectionRequest, { status: rejectionResponse.status(), body: rejectionBody }, 'REJECTED', rejectionBody)
      expect(rejectionResponse.status()).toBe(200)
      expect(rejectionBody.valid).toBe(false)
      expect(rejectionBody.errors).toEqual(expect.arrayContaining([expect.any(String)]))
      expect(rejectionBody.errors.every((error: unknown) => typeof error === 'string' && error.trim())).toBe(true)

      const submissionRequest = { dataset, idempotencyKey: createHash('sha256').update(`qualified-contract:${dataset.kind}:${dataset.period}`).digest('hex') }
      const submissionResponse = await context.post(`${endpoint}/submit`, { data: submissionRequest })
      const submissionBody = await submissionResponse.json()
      const receiptSha256 = typeof submissionBody.receipt === 'string' ? createHash('sha256').update(submissionBody.receipt).digest('hex') : null
      await retain('acceptance', submissionRequest, { status: submissionResponse.status(), body: submissionBody }, 'ACCEPTED', { ...submissionBody, receiptSha256 })
      expect(submissionResponse.status()).toBe(200)
      expect(submissionBody.outcome).toBe('accepted')
      expect(submissionBody.errors ?? []).toEqual([])
      expect(submissionBody.receipt).toEqual(expect.any(String))
      expect(submissionBody.receipt.trim()).not.toBe('')
    } finally { await context.dispose() }
  })
})
