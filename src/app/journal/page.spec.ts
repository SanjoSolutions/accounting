import { describe, expect, it, vi } from 'vitest'

vi.mock('@/server/authentication', () => ({
  requirePageUser: vi.fn(async () => ({ id: 'owner-1' })),
}))
vi.mock('@/AccountingWorkspace', () => ({
  AccountingWorkspace: vi.fn(),
}))

import { journalYearFromSearchParameter } from './page'

describe('journal fiscal-year deep links', () => {
  it('uses the requested valid fiscal year', () => {
    expect(journalYearFromSearchParameter('2025', 2026)).toBe(2025)
  })

  it.each([undefined, ['2025'], '25', '2025.5', '1899', '2201'])(
    'falls back to the current year for invalid value %j',
    value => {
      expect(journalYearFromSearchParameter(value, 2026)).toBe(2026)
    },
  )
})
