import { describe, expect, it, vi } from 'vitest'
import type { CompanyProfile } from '@/server/compliance/companyProfile'

vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: {} }))

import { selectProfileVersionForPeriod } from './profileRepository'

const profile: CompanyProfile = { companyName: 'Tenant GmbH', legalForm: 'GMBH', taxNumber: '12/345/67890', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Software', sizeClass: 'SMALL', chart: 'SKR03', elections: [] }

describe('effective tax company profile', () => {
  it('selects the immutable version covering the complete filing period', () => {
    const selected = selectProfileVersionForPeriod([{ effectiveFrom: new Date('2025-01-01'), effectiveTo: new Date('2026-12-31'), payload: JSON.stringify(profile) }], new Date('2026-01-01'), new Date('2026-12-31'))
    expect(selected.legalForm).toBe('GMBH')
  })
  it('fails closed when a profile transition occurs inside the filing period', () => {
    const versions = [
      { effectiveFrom: new Date('2025-01-01'), effectiveTo: null, payload: JSON.stringify(profile) },
      { effectiveFrom: new Date('2026-07-01'), effectiveTo: null, payload: JSON.stringify({ ...profile, vatFilingFrequency: 'QUARTERLY' }) },
    ]
    expect(() => selectProfileVersionForPeriod(versions, new Date('2026-01-01'), new Date('2026-12-31'))).toThrow(/transitions inside/)
  })
})
