export type HgbReviewMode = 'INDEPENDENT' | 'OWNER_SELF_REVIEW'

export interface HgbReviewPolicyChoice {
  mode: HgbReviewMode
  reason: string
  evidenceIds: string[]
  soleShareholderManagingDirector: boolean
  noAdditionalReviewRequirement: boolean
}

export interface HgbReviewPolicy extends HgbReviewPolicyChoice {
  id: string
  checksum: string
  version: number
  ownerId: string
  selectedBy: string
  selectedAt: string
}

export function validateHgbReviewPolicyChoice(value: HgbReviewPolicyChoice): HgbReviewPolicyChoice {
  if (!value || !['INDEPENDENT', 'OWNER_SELF_REVIEW'].includes(value.mode)) throw new TypeError('Select a supported HGB review policy.')
  if (typeof value.reason !== 'string' || !value.reason.trim()) throw new TypeError('A policy selection reason is required.')
  if (!Array.isArray(value.evidenceIds) || !value.evidenceIds.length || value.evidenceIds.some(id => typeof id !== 'string' || !id.trim())) throw new TypeError('Retained policy evidence is required.')
  if (value.mode === 'OWNER_SELF_REVIEW' && (value.soleShareholderManagingDirector !== true || value.noAdditionalReviewRequirement !== true)) throw new TypeError('Owner self-review requires evidence of a sole shareholder/managing director and no additional independent-review obligation.')
  return { mode: value.mode, reason: value.reason.trim(), evidenceIds: [...new Set(value.evidenceIds.map(id => id.trim()))].sort(), soleShareholderManagingDirector: value.soleShareholderManagingDirector === true, noAdditionalReviewRequirement: value.noAdditionalReviewRequirement === true }
}

export function assertReviewIdentity(preparedBy: string, reviewerId: string, policy?: HgbReviewPolicy | null) {
  if (!preparedBy?.trim() || !reviewerId?.trim()) throw new TypeError('Preparer and reviewer are required.')
  if (preparedBy !== reviewerId) return 'INDEPENDENT' as const
  if (policy?.mode !== 'OWNER_SELF_REVIEW' || policy.ownerId !== reviewerId || policy.selectedBy !== reviewerId || !policy.soleShareholderManagingDirector || !policy.noAdditionalReviewRequirement) throw new TypeError('Reviewer must be distinct from preparer unless the owner selected an eligible self-review policy.')
  return 'OWNER_SELF_REVIEW' as const
}

export function reviewMatchesPolicy(record: { preparedBy?: string | null; reviewedBy?: string | null; reviewedAt?: string | Date | null; reviewReason?: string | null; reviewMode?: string | null; reviewPolicyId?: string | null }, policy?: HgbReviewPolicy | null) {
  try {
    const mode = assertReviewIdentity(record.preparedBy ?? '', record.reviewedBy ?? '', policy)
    if ((record.reviewPolicyId ?? null) !== (policy?.id ?? null)) return false
    if ((record.reviewMode ?? 'INDEPENDENT') !== mode) return false
    if (mode === 'OWNER_SELF_REVIEW' && !record.reviewReason?.trim()) return false
    return Boolean(record.reviewedAt && Number.isFinite(new Date(record.reviewedAt).getTime()))
  } catch { return false }
}
