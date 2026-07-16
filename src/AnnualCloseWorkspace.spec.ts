import { describe, expect, it } from 'vitest'
import { canCloseYear, getCloseSteps } from './AnnualCloseWorkspace'

describe('annual close assistant', () => {
  it('keeps the irreversible close disabled until readiness data loaded successfully', () => {
    const data = { fiscalYear: { year: 2026, status: 'OPEN', lockedAt: null }, closingIssues: [], entries: [{}], statements: { assetsCents: 0, liabilitiesCents: 0, equityCents: 0, revenueCents: 0, expenseCents: 0, netIncomeCents: 0, balanceDifferenceCents: 0 } }
    expect(canCloseYear(null, [], false, false)).toBe(false)
    expect(canCloseYear(data, [], true, false)).toBe(false)
    expect(canCloseYear(data, [], false, false)).toBe(true)
    expect(canCloseYear(data, [], false, false, 2025)).toBe(false)
    expect(canCloseYear({ ...data, fiscalYear: { ...data.fiscalYear, status: 'CLOSED' } }, [], false, false)).toBe(false)
  })
  it('keeps mapping, statements and lock incomplete while blockers remain', () => {
    const steps = getCloseSteps({
      fiscalYear: { year: 2026, status: 'OPEN', lockedAt: null }, closingIssues: ['Mapping fehlt'],
      entries: [{}], statements: { assetsCents: 0, liabilitiesCents: 0, equityCents: 0, revenueCents: 0, expenseCents: 0, netIncomeCents: 0, balanceDifferenceCents: 0 },
    })
    expect(steps.map(step => step.done)).toEqual([true, false, false, false])
  })
})
