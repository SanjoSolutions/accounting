import { expect, test } from '@playwright/test'
import { taxFormRegistry, type DeclarationDataset } from '../src/core/taxDeclarations'
import { secureServiceEndpoint } from '../src/server/tax/transport'

const rawEndpoint = process.env.ANNUAL_TAX_GATEWAY_CONTRACT_URL?.trim()
const credential = process.env.ANNUAL_TAX_GATEWAY_CONTRACT_CREDENTIAL?.trim()
const taxpayerId = process.env.ANNUAL_TAX_GATEWAY_CONTRACT_TAXPAYER_ID?.trim() || 'annual-tax-contract-ug-2025'
const configured = Boolean(rawEndpoint && credential)
const endpoint = rawEndpoint ? secureServiceEndpoint(rawEndpoint, 'ANNUAL_TAX_GATEWAY_CONTRACT_URL', false) : undefined

const datasets: DeclarationDataset[] = [
  taxFormRegistry.prepare('KST', '2025', {
    STEUERLICHES_ERGEBNIS: 10_100_000,
  }, {
    STEUERLICHES_ERGEBNIS: ['contract-evidence-hgb-close'],
  }, taxpayerId),
  taxFormRegistry.prepare('GEWST', '2025', {
    GEWERBEERTRAG: 10_100_000,
    GEMEINDE: '11000000',
    HEBESATZ_BP: 41_000,
  }, {
    GEWERBEERTRAG: ['contract-evidence-hgb-close'],
  }, taxpayerId),
]

test.describe('external annual-tax gateway validation contract (not ERiC interoperability proof)', () => {
  test.skip(!configured, 'Set explicit ANNUAL_TAX_GATEWAY_CONTRACT_URL and ANNUAL_TAX_GATEWAY_CONTRACT_CREDENTIAL values to exercise an authorised external test gateway.')

  for (const dataset of datasets) {
    test(`validates the ${dataset.formVersion} transport contract without mocks`, async ({ playwright }) => {
      const client = await playwright.request.newContext({
        extraHTTPHeaders: {
          authorization: `Bearer ${credential}`,
          'content-type': 'application/json',
        },
      })

      try {
        const response = await client.post(`${endpoint}/validate`, { data: { dataset } })
        expect(response.ok(), `External gateway returned HTTP ${response.status()}.`).toBe(true)
        const body: unknown = await response.json()
        expect(body).toEqual(expect.objectContaining({ valid: true, errors: [] }))
        if (Object.hasOwn(body as object, 'protocol')) {
          expect((body as { protocol?: unknown }).protocol).toEqual(expect.any(String))
          expect((body as { protocol: string }).protocol.trim()).not.toBe('')
        }
      } finally {
        await client.dispose()
      }
    })
  }
})
