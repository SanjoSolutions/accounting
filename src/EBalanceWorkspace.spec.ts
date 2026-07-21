import { describe, expect, it } from 'vitest'
import { canRunEBalanceAction, canSubmitEBalance, filterEBalanceLedgerIssues, invalidateReportApproval, isActiveSubmissionStatus, isCurrentEBalanceYear, isDefinitiveUnsentResult, isEBalanceMasterDataLocked, lifecycleOverviewPath, parseEricStatus, parseLifecycleOverview, readJsonResponse, resetSubmissionForYear, resolveJsonRequest, responseIssues, scopeLifecycleOverview } from './EBalanceWorkspace'

describe('E-Bilanz submission guard', () => {
  it('allows a binding submission only with ready ERiC, closed year, confirmation, and PIN', () => {
    expect(canSubmitEBalance(true, 'CLOSED', true, '123456')).toBe(true)
    expect(canSubmitEBalance(false, 'CLOSED', true, '123456')).toBe(false)
    expect(canSubmitEBalance(true, 'OPEN', true, '123456')).toBe(false)
    expect(canSubmitEBalance(true, 'CLOSED', false, '123456')).toBe(false)
    expect(canSubmitEBalance(true, 'CLOSED', true, '')).toBe(false)
    expect(canSubmitEBalance(true, 'CLOSED', true, '123456', true)).toBe(false)
    expect(canSubmitEBalance(true, 'CLOSED', true, '123456', false, true)).toBe(false)
  })

  it('blocks every E-Balance action until the ledger loaded successfully', () => {
    expect(canRunEBalanceAction('loading', [])).toBe(false)
    expect(canRunEBalanceAction('failed', [])).toBe(false)
    expect(canRunEBalanceAction('ready', ['Taxonomy mapping missing'])).toBe(false)
    expect(canRunEBalanceAction('ready', [], true)).toBe(false)
    expect(canRunEBalanceAction('ready', [])).toBe(true)
  })

  it('blocks repeat submission while an earlier submission is active or accepted', () => {
    expect(['PENDING', 'UNKNOWN', 'ACCEPTED'].every(isActiveSubmissionStatus)).toBe(true)
    expect(isActiveSubmissionStatus('REJECTED')).toBe(false)
  })

  it('keeps a closed prior year reportable despite a closed successor', () => {
    const issue = 'Das bereits abgeschlossene Folgejahr 2026 verhindert einen nachträglichen Abschluss.'
    expect(filterEBalanceLedgerIssues('CLOSED', [issue])).toEqual([])
    expect(filterEBalanceLedgerIssues('OPEN', [issue])).toEqual([issue])
  })

  it('invalidates consent and validation feedback after report data changes', () => {
    expect(invalidateReportApproval()).toEqual({ confirmed: false, message: '' })
  })

  it('rotates retry identity only after an explicit unsent response', () => {
    expect(isDefinitiveUnsentResult(422, false)).toBe(true)
    expect(isDefinitiveUnsentResult(500, false)).toBe(false)
    expect(isDefinitiveUnsentResult(undefined, undefined)).toBe(false)
  })

  it('does not confuse unrelated history with the current submission identity', () => {
    const history = [{ idempotencyKey: 'older-key' }, { idempotencyKey: 'current-key' }]
    expect(history.find(item => item.idempotencyKey === 'current-key')).toEqual({ idempotencyKey: 'current-key' })
    expect(history.find(item => item.idempotencyKey === 'missing-key')).toBeUndefined()
  })

  it('creates a clean submission identity when the fiscal year changes', () => {
    expect(resetSubmissionForYear(() => 'new-year-key')).toEqual({ idempotencyKey: 'new-year-key', uncertain: false, confirmed: false })
  })

  it('discards asynchronous results from a fiscal year that is no longer selected', () => {
    expect(isCurrentEBalanceYear(2026, 2026)).toBe(true)
    expect(isCurrentEBalanceYear(2025, 2026)).toBe(false)
  })

  it('locks report master data while export or ERiC processing is in flight', () => {
    expect(isEBalanceMasterDataLocked(true, false)).toBe(true)
    expect(isEBalanceMasterDataLocked(false, true)).toBe(true)
    expect(isEBalanceMasterDataLocked(false, false)).toBe(false)
  })
})

describe('E-Bilanz API error handling', () => {
  it('accepts only complete lifecycle registry and immutable-version payloads', () => {
    const overview = { data: { taxonomies: [{ version: '6.10', validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31' }], reports: [{ id: 'report-1', fiscalYearId: 'fy-1', version: 1, status: 'PREPARED', taxonomyVersion: '6.10', reportChecksum: 'abc', createdAt: '2026-12-31T12:00:00Z' }], reconciliations: [{ id: 'adjustment-1', fiscalYearId: 'fy-1', kind: 'ADJUSTMENT' }] } }
    expect(parseLifecycleOverview(overview)?.reports[0].taxonomyVersion).toBe('6.10')
    expect(parseLifecycleOverview({ data: { ...overview.data, reports: [{ id: 'incomplete' }] } })).toBeNull()
  })
  it('requests and retains lifecycle evidence only for the selected fiscal period', () => {
    expect(lifecycleOverviewPath('period/2026')).toBe('/api/compliance/e-bilanz?fiscalYearId=period%2F2026')
    const overview = parseLifecycleOverview({ data: { taxonomies: [], reports: [
      { id: '2025-report', fiscalYearId: 'fy-2025', version: 1, status: 'PREPARED', taxonomyVersion: '6.9', reportChecksum: 'old', createdAt: '2025-12-31' },
      { id: '2026-report', fiscalYearId: 'fy-2026', version: 1, status: 'PREPARED', taxonomyVersion: '6.10', reportChecksum: 'current', createdAt: '2026-12-31' },
    ], reconciliations: [{ id: 'old', fiscalYearId: 'fy-2025', kind: 'ADJUSTMENT' }, { id: 'current', fiscalYearId: 'fy-2026', kind: 'ADJUSTMENT' }] } })!
    expect(scopeLifecycleOverview(overview, 'fy-2026')).toMatchObject({ reports: [{ id: '2026-report' }], reconciliations: [{ id: 'current' }] })
  })
  it('rejects malformed nested ERiC status payloads', () => {
    expect(parseEricStatus({ readiness: {}, fiscalYearStatus: 'CLOSED', history: [] })).toBeNull()
    expect(parseEricStatus({ readiness: { validationReady: true, submissionReady: true, testMode: false, issues: [] }, fiscalYearStatus: 'CLOSED', history: [null] })).toBeNull()
    expect(parseEricStatus({ readiness: { validationReady: true, submissionReady: true, testMode: false, issues: [] }, fiscalYearStatus: 'CLOSED', history: [{ id: '1', kind: 'SUBMISSION', status: 'ACCEPTED', idempotencyKey: 'key', ericMessage: null, createdAt: '2026-01-01' }] })?.history).toHaveLength(1)
  })
  it('falls back safely for non-JSON responses and malformed issue payloads', async () => {
    const htmlResponse = new Response('<html>gateway error</html>', { status: 502, headers: { 'content-type': 'text/html' } })
    expect(await readJsonResponse(htmlResponse)).toBeNull()
    expect(responseIssues(null, 'Export failed')).toEqual(['Export failed'])
    expect(responseIssues({ issues: [null, '', 42] }, 'Export failed')).toEqual(['Export failed'])
    expect(responseIssues({ issues: ['Official validation failed'] }, 'Fallback')).toEqual(['Official validation failed'])
  })

  it('turns network errors and non-JSON HTTP errors into visible fallback issues', async () => {
    await expect(resolveJsonRequest(() => Promise.reject(new TypeError('network unavailable')), 'Could not load data')).resolves.toMatchObject({
      response: null,
      data: null,
      issues: ['Could not load data'],
    })
    const result = await resolveJsonRequest(() => Promise.resolve(new Response('not json', { status: 500 })), 'Official processing failed')
    expect(result.response?.status).toBe(500)
    expect(result.data).toBeNull()
    expect(result.issues).toEqual(['Official processing failed'])
  })
})
