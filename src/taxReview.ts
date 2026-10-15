import type { UstvaCopyContext } from './UstvaCopyView'

export interface PreparedTaxDataset {
  kind: string
  period: string
  taxpayerId?: string
  formVersion?: string
  fields: Record<string, number | string | boolean>
  drilldown: Record<string, readonly string[]>
}

export interface TaxPreparationResult {
  dataset: PreparedTaxDataset
  copyContext?: UstvaCopyContext
  annualPreview?: { notice: string; ruleVersion: string; preview: Record<string, number> }
}

export function supportsLocalTaxReview(kind: string, year: number) {
  return [2025, 2026].includes(year) && ['USTVA', 'UST_ANNUAL', 'KST', 'GEWST'].includes(kind)
}

/** Only these preparation routes are independent of external calculation/filing services. */
export function localTaxReviewRequest(kind: string, period: string, year: number): [string, RequestInit?] {
  if (!supportsLocalTaxReview(kind, year)) throw new Error('Local preparation supports UStVA, annual VAT, KSt and GewSt for 2025/2026 only.')
  if (kind === 'USTVA') return [`/api/tax/vat-reconciliation?period=${encodeURIComponent(period)}`]
  if (kind === 'UST_ANNUAL') return [`/api/tax/vat-annual?year=${year}`]
  return ['/api/tax/annual/narrow', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ year }) }]
}

/** Fetches the prepared dataset without calling a workflow validation/submission route. */
export async function prepareTaxReview(
  request: [string, RequestInit?], kind: string, period: string, failureMessage: string,
  fetcher: typeof fetch = fetch,
): Promise<TaxPreparationResult> {
  const response = await fetcher(...request)
  let body
  try { body = await response.json() }
  catch { throw new Error(failureMessage) }
  if (!response.ok) throw new Error(Array.isArray(body.issues) ? body.issues.join(' ') : failureMessage)
  const data = body.data
  const dataset = ['USTVA', 'UST_ANNUAL'].includes(kind) ? data?.dataset : data?.datasets?.find((candidate: PreparedTaxDataset) => candidate.kind === kind)
  if (!dataset || dataset.kind !== kind || dataset.period !== period) throw new Error(failureMessage)
  return {
    dataset,
    ...(kind === 'USTVA' && data.copyContext ? { copyContext: data.copyContext } : {}),
    ...(data.preview && data.notice && data.ruleVersion ? { annualPreview: { notice: data.notice, ruleVersion: data.ruleVersion, preview: data.preview } } : {}),
  }
}

export function taxReviewDownload(result: TaxPreparationResult, preparedAt: string) {
  const { dataset } = result
  // Explicit projection keeps workflow receipts/approval flags out of this local snapshot.
  const contents = JSON.stringify({
    format: 'accounting-tax-review-v1',
    purpose: 'LOCAL_REVIEW_ONLY',
    notice: 'Local preparation snapshot. Not an ELSTER import file, official validation, portal draft or proof of filing. Review and transfer values manually; save the form in Mein ELSTER without submitting.',
    portalDraftCreated: false,
    transmissionPerformed: false,
    preparedAt,
    dataset: { kind: dataset.kind, period: dataset.period, taxpayerId: dataset.taxpayerId, formVersion: dataset.formVersion, fields: dataset.fields, drilldown: dataset.drilldown },
    ...(result.copyContext ? { company: result.copyContext } : {}),
    ...(result.annualPreview ? { annualPreview: result.annualPreview } : {}),
    numericUnits: { monetaryAmounts: 'EUR cents', HEBESATZ_BP: 'basis points' },
  }, null, 2)
  const safeName = `${dataset.kind}-${dataset.period}`.replace(/[^a-zA-Z0-9_-]/g, '_')
  return { fileName: `tax-review-${safeName}.json`, contents }
}

export const meinElsterFormsUrl = 'https://www.elster.de/eportal/formulare-leistungen/alleformulare'

export function taxReviewFieldUnit(field: string, value: number | string | boolean) {
  if (typeof value !== 'number') return 'text'
  if (field === 'HEBESATZ_BP') return 'basis-points'
  if (/^KZ\d+$/.test(field) || ['ZAHLLAST', 'STEUERLICHES_ERGEBNIS', 'KST_SCHULD', 'GEWERBEERTRAG', 'GEWST_SCHULD', 'EINKUENFTE_GEWERBEBETRIEB', 'EST_SCHULD', 'FESTZUSTELLENDE_EINKUENFTE'].includes(field)) return 'cents'
  return 'text'
}
