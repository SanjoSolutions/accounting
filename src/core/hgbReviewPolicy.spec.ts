import { describe, expect, test } from 'vitest'
import { assertReviewIdentity, reviewMatchesPolicy, validateHgbReviewPolicyChoice, type HgbReviewPolicy } from './hgbReviewPolicy'

export const ownerPolicy: HgbReviewPolicy = { id: 'policy-1', checksum: 'a'.repeat(64), ownerId: 'owner', selectedBy: 'owner', selectedAt: '2027-01-15T10:00:00Z', version: 1, mode: 'OWNER_SELF_REVIEW', reason: 'Sole shareholder and managing director; articles checked.', evidenceIds: ['register-and-articles'], soleShareholderManagingDirector: true, noAdditionalReviewRequirement: true }

describe('explicit owner review policy', () => {
  test('Given no selected policy, when the preparer reviews, then independent review remains mandatory', () => {
    expect(() => assertReviewIdentity('owner', 'owner')).toThrow(/distinct/)
    expect(assertReviewIdentity('owner', 'reviewer')).toBe('INDEPENDENT')
  })
  test('Given evidence-backed sole-owner selection, when that owner reviews, then their real identity is retained as self-review', () => {
    expect(validateHgbReviewPolicyChoice(ownerPolicy).mode).toBe('OWNER_SELF_REVIEW')
    expect(assertReviewIdentity('owner', 'owner', ownerPolicy)).toBe('OWNER_SELF_REVIEW')
    expect(() => assertReviewIdentity('employee', 'employee', ownerPolicy)).toThrow(/distinct/)
    expect(() => assertReviewIdentity('owner', 'owner', { ...ownerPolicy, selectedBy: 'employee' })).toThrow(/distinct/)
  })
  test.each([{ reason: '' }, { evidenceIds: [] }, { soleShareholderManagingDirector: false }, { noAdditionalReviewRequirement: false }])('Given missing eligibility or evidence %j, when selecting self-review, then selection fails', patch => {
    expect(() => validateHgbReviewPolicyChoice({ ...ownerPolicy, ...patch })).toThrow()
  })
  test('Given a reviewed workpaper, when its policy changes or self-review semantics are absent, then its review becomes invalid', () => {
    const record = { preparedBy: 'owner', reviewedBy: 'owner', reviewedAt: '2027-01-16T10:00:00Z', reviewReason: 'Rechecked every source', reviewMode: 'OWNER_SELF_REVIEW', reviewPolicyId: ownerPolicy.id }
    expect(reviewMatchesPolicy(record, ownerPolicy)).toBe(true)
    expect(reviewMatchesPolicy(record, { ...ownerPolicy, id: 'policy-2' })).toBe(false)
    expect(reviewMatchesPolicy({ ...record, reviewReason: '' }, ownerPolicy)).toBe(false)
    expect(reviewMatchesPolicy({ ...record, reviewMode: 'INDEPENDENT' }, ownerPolicy)).toBe(false)
    expect(reviewMatchesPolicy({ ...record, reviewedAt: 'invalid' }, ownerPolicy)).toBe(false)
  })
})
