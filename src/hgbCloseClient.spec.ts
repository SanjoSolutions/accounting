import { describe, expect, it } from 'vitest'
import { latestRunBlockers, operationStillCurrent } from './hgbCloseClient'

describe('HGB close client concurrency guard', () => {
  it('accepts a response only for the selected year and latest generation', () => {
    expect(operationStillCurrent(2026, 2026, 4, 4)).toBe(true)
    expect(operationStillCurrent(2025, 2026, 4, 4)).toBe(false)
    expect(operationStillCurrent(2026, 2026, 3, 4)).toBe(false)
  })
  it('reads blockers from the immutable close-run readiness payload', () => {
    expect(latestRunBlockers({ id: 'run', version: 1, status: 'BLOCKED', ledgerFingerprint: 'fingerprint', payload: { readiness: { blockers: [{ code: 'MISSING', message: 'Nachweis fehlt', authority: 'HGB' }] } } })).toHaveLength(1)
  })
})
