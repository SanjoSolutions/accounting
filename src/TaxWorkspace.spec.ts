import { describe, expect, it } from 'vitest'
import { parseAnnualValues, parseDeclarationFields, preparationSourceAfterValidation, requestKeyAfterPreparation, shouldReplaySubmissionFailure, submissionOutcomeMessage, submissionRequestKey, submissionSuccessMessage, workspaceLoadStatus } from './TaxWorkspace'

describe('tax filing workspace', () => {
  it('accepts official integer-cent fields for the usable validation/submission form', () => expect(parseDeclarationFields('{"KZ81":10000,"USTID_OK":true}')).toEqual({ KZ81: 10000, USTID_OK: true }))
  it('rejects unsafe or nested hand-edited field values before transmission', () => {
    expect(() => parseDeclarationFields('{"KZ81":1.5}')).toThrow(/safe integer/)
    expect(() => parseDeclarationFields('{"KZ81":{"nested":1}}')).toThrow(/object of strings/)
  })
  it('keeps one idempotency key for retries of the unchanged approved dataset', () => {
    const generate = () => 'request-key-1'
    const first = submissionRequestKey(null, generate)
    expect(submissionRequestKey(first, () => 'request-key-2')).toBe(first)
  })
  it('clears the request key when preparation produces a different exact dataset', () => {
    expect(requestKeyAfterPreparation('request-key-1', 'hash-a', 'hash-a')).toBe('request-key-1')
    expect(requestKeyAfterPreparation('request-key-1', 'hash-a', 'hash-b')).toBeNull()
  })
  it('replays only failed binding submissions that retain their exact dataset and request key', () => {
    const prepared = { kind: 'USTVA', period: '2026-01', fields: { ZAHLLAST: 0 }, drilldown: {} }
    expect(shouldReplaySubmissionFailure('submit', 'request-key-1234', prepared)).toBe(true)
    expect(shouldReplaySubmissionFailure('validate', undefined, prepared)).toBe(false)
    expect(shouldReplaySubmissionFailure('submit', 'request-key-1234', null)).toBe(false)
  })
  it('accepts the annual preparation value array used by applicable annual forms', () => {
    expect(parseAnnualValues('[{"field":"HGB_RESULT","amountCents":100}]')).toEqual([{ field: 'HGB_RESULT', amountCents: 100 }])
    expect(() => parseAnnualValues('{"field":"HGB_RESULT"}')).toThrow(/must be an array/)
  })
  it('retains annual source values after preparation while displaying reconciled VAT fields', () => {
    const annualSource = '[{"field":"HGB_RESULT","amountCents":100}]'
    const annualDataset = { kind: 'KST', period: '2026', fields: { KST_SCHULD: 15 }, drilldown: {} }
    expect(preparationSourceAfterValidation('KST', annualSource, annualDataset)).toBe(annualSource)
    expect(preparationSourceAfterValidation('USTVA', '{}', { ...annualDataset, kind: 'USTVA' })).toContain('"KST_SCHULD": 15')
  })
  it('preserves a successful submission result when refreshing history fails', () => {
    expect(submissionSuccessMessage('Submitted.', true, 'History could not be loaded.')).toBe('Submitted. History could not be loaded.')
  })
  it('does not report in-flight, uncertain or rejected filings as accepted', () => {
    const messages = { accepted: 'accepted', pending: 'pending', rejected: 'rejected', failed: 'failed' }
    expect(submissionOutcomeMessage('accepted', messages)).toBe('accepted')
    expect(submissionOutcomeMessage('submitting', messages)).toBe('pending')
    expect(submissionOutcomeMessage('uncertain', messages)).toBe('pending')
    expect(submissionOutcomeMessage('rejected', messages)).toBe('rejected')
  })
  it('keeps VAT workflow history available when optional annual applicability is unavailable', () => {
    expect(workspaceLoadStatus(true, false)).toEqual({ historyAvailable: true, annualAvailable: false })
  })
})
