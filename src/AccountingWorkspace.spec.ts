import { describe, expect, it } from 'vitest'
import { bookingFormRows, isBookingFormDisabled, shouldApplyWorkspace } from './AccountingWorkspace'

describe('accounting workspace request ordering', () => {
  it('applies only a non-aborted response for the currently selected year', () => {
    expect(shouldApplyWorkspace(2026, 2026, false)).toBe(true)
    expect(shouldApplyWorkspace(2025, 2026, false)).toBe(false)
    expect(shouldApplyWorkspace(2026, 2026, true)).toBe(false)
    expect(shouldApplyWorkspace(2026, 2026, false, 1, 2)).toBe(false)
    expect(shouldApplyWorkspace(2026, 2026, false, 2, 2)).toBe(true)
  })

  it('locks every booking input while a posting is being transferred', () => {
    expect(isBookingFormDisabled(true)).toBe(true)
    expect(isBookingFormDisabled(false)).toBe(false)
    expect(isBookingFormDisabled(false, true)).toBe(true)
  })

  it('places posting text in its own full-width row', () => {
    expect(bookingFormRows()).toEqual([['bookingDate', 'documentNumber'], ['description']])
  })

})
