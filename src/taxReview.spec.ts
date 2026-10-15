import { describe, expect, test, vi } from 'vitest'
import { localTaxReviewRequest, meinElsterFormsUrl, prepareTaxReview, supportsLocalTaxReview, taxReviewDownload, taxReviewFieldUnit } from './taxReview'

describe('local tax review handoff', () => {
  test.each(['USTVA', 'UST_ANNUAL', 'KST', 'GEWST'])('Given %s sources, when prepared for review, then only the local preparation endpoint is called', async kind => {
    const period = kind === 'USTVA' ? '2026-Q3' : '2026'
    const dataset = { kind, period, taxpayerId: 'synthetic-company', formVersion: `${kind}-2026.1`, fields: { ZAHLLAST: 100 }, drilldown: { ZAHLLAST: ['source-1'] } }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { dataset, datasets: [dataset] } }))
    const request = localTaxReviewRequest(kind, period, 2026)
    const result = await prepareTaxReview(request, kind, period, 'Preparation failed.', fetcher)
    expect(result.dataset).toEqual(dataset)
    expect(fetcher.mock.calls).toEqual([[...request]])
    expect(fetcher.mock.calls[0][0]).not.toMatch(/workflows|https?:/)
  })

  test('Given a form requiring an external calculator or an unsupported year, when local preparation is requested, then it fails before contacting a service', () => {
    for (const [kind, year] of [['EST_BUSINESS', 2026], ['KST', 2027], ['FESTSTELLUNG', 2026]] as const) {
      expect(supportsLocalTaxReview(kind, year)).toBe(false)
      expect(() => localTaxReviewRequest(kind, String(year), year)).toThrow(/only/)
    }
  })

  test('Given unavailable or mismatched preparation, when reviewed, then no stale draft or follow-up request is produced', async () => {
    for (const response of [
      Response.json({ issues: ['Missing current sources.'] }, { status: 422 }),
      new Response(null, { status: 500 }),
      Response.json({ data: { dataset: { kind: 'USTVA', period: '2025-01' } } }),
      Response.json({ data: { dataset: { kind: 'KST', period: '2026-01' } } }),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
      await expect(prepareTaxReview(['/api/tax/vat-reconciliation?period=2026-01'], 'USTVA', '2026-01', 'Preparation failed.', fetcher)).rejects.toThrow(/Missing current sources|Preparation failed/)
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
  })

  test('Given a prepared annual dataset, when downloaded, then the local snapshot retains source references and explicitly disclaims filing and import compatibility', () => {
    const result = {
      dataset: { kind: 'GEWST', period: '2026', taxpayerId: 'synthetic-company', formVersion: 'GEWST-2026.1', fields: { GEWERBEERTRAG: 10000, HEBESATZ_BP: 40000, GEMEINDE: '11000000' }, drilldown: { GEWERBEERTRAG: ['ledger-1', 'adjustment-1'] }, receipt: 'must-not-be-exported' },
      annualPreview: { notice: 'Non-binding preview', ruleVersion: '2026.1', preview: { tradeTaxCents: 1400 } },
    }
    const file = taxReviewDownload(result, '2026-10-15T12:00:00.000Z')
    expect(file.fileName).toBe('tax-review-GEWST-2026.json')
    const contents = JSON.parse(file.contents)
    expect(contents).toMatchObject({ purpose: 'LOCAL_REVIEW_ONLY', portalDraftCreated: false, transmissionPerformed: false, preparedAt: '2026-10-15T12:00:00.000Z', annualPreview: result.annualPreview })
    expect(contents.dataset).toMatchObject({ taxpayerId: 'synthetic-company', fields: result.dataset.fields, drilldown: result.dataset.drilldown, formVersion: 'GEWST-2026.1' })
    expect(contents.notice).toContain('Not an ELSTER import file')
    expect(contents.dataset).not.toHaveProperty('receipt')
    expect(contents.numericUnits.HEBESATZ_BP).toBe('basis points')
  })

  test('Given a VAT preparation, when reviewed, then company context survives and the external link contains no taxpayer data', async () => {
    const dataset = { kind: 'USTVA', period: '2026-01', fields: { KZ81: 10000, ZAHLLAST: 1900 }, drilldown: {} }
    const copyContext = { companyName: 'Synthetic Example', taxNumber: 'test-only', taxOffice: 'Berlin', filingFrequency: 'MONTHLY' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: { dataset, copyContext } }))
    const result = await prepareTaxReview(['/api/tax/vat-reconciliation?period=2026-01'], 'USTVA', '2026-01', 'Failed', fetcher)
    expect(JSON.parse(taxReviewDownload(result, '2026-10-15T12:00:00.000Z').contents).company).toEqual(copyContext)
    expect(meinElsterFormsUrl).toBe('https://www.elster.de/eportal/formulare-leistungen/alleformulare')
  })

  test('Given monetary values, rates and municipality identifiers, when reviewed, then amounts and rates have distinct units and identifiers stay intact', () => {
    expect(taxReviewFieldUnit('KZ81', 10000)).toBe('cents')
    expect(taxReviewFieldUnit('GEWERBEERTRAG', 10000)).toBe('cents')
    expect(taxReviewFieldUnit('HEBESATZ_BP', 40000)).toBe('basis-points')
    expect(taxReviewFieldUnit('GEMEINDE', '01001000')).toBe('text')
    expect(taxReviewFieldUnit('UNKNOWN', 123)).toBe('text')
  })
})
