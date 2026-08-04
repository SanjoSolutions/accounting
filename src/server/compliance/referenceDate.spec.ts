import { describe, expect, it } from 'vitest'
import { complianceReferenceDate } from './referenceDate'

describe('compliance reference date', () => {
  it('uses the real system date unless an explicit non-production E2E date is configured', () => { expect(complianceReferenceDate({}, '2026-08-04')).toBe('2026-08-04'); expect(complianceReferenceDate({ NODE_ENV: 'test', COMPLIANCE_E2E_REFERENCE_DATE: '2027-01-02' }, '2026-08-04')).toBe('2027-01-02') })
  it('fails closed for production or impossible-date overrides', () => { expect(() => complianceReferenceDate({ NODE_ENV: 'production', COMPLIANCE_E2E_REFERENCE_DATE: '2027-01-02' })).toThrow(/forbidden/); expect(() => complianceReferenceDate({ NODE_ENV: 'test', COMPLIANCE_E2E_REFERENCE_DATE: '2027-02-30' })).toThrow(/real ISO/) })
})
