import type { EBalanceLegalForm } from './eBilanz'
import type { EBalanceTaxonomyModel } from './eBilanzTaxonomyModel'

export interface EBalanceReportProfile {
  accountingStandard: string
  incomeStatementMethod: string
  statementType: string
  reportStatus: string
  consolidationRange: string
  incomeClassification: string
  specialBalanceRequired?: boolean
  supplementaryBalanceRequired?: boolean
}
/** Reviewed form scope within the official release registry. This is the
 * application's supported subset, not a claim to support every official form. */
export const E_BALANCE_CORPORATE_ANNUAL_FORM = Object.freeze({
  taxonomyVersions: Object.freeze(['6.9', '6.10']),
  legalForms: Object.freeze(['UG', 'GMBH', 'AG']),
  sourceProfile: Object.freeze({ accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }),
  revisionStatuses: Object.freeze(['E', 'B', 'G', 'BG', 'I']),
})
export interface EBalanceRevision {
  status: 'E' | 'B' | 'G' | 'BG' | 'I'
  reason: string
  /** Reference only; the persistence owner verifies tenant, period and immutable history. */
  supersedes: { reportId: string; reportChecksum: string } | null
}
export const E_BALANCE_ATTACHMENT_KINDS = ['NOTES', 'MANAGEMENT_REPORT', 'AUDIT_REPORT', 'TAX_ELECTION_REGISTER'] as const
export type EBalanceAttachmentKind = typeof E_BALANCE_ATTACHMENT_KINDS[number]
export type EBalanceAttachmentDeclaration = { kind: EBalanceAttachmentKind } & (
  { status: 'PRESENT'; text: string; evidenceIds: string[] }
  | { status: 'NOT_APPLICABLE'; reason: string }
)
export const E_BALANCE_ATTACHMENT_CONCEPTS: Record<EBalanceAttachmentKind, { concept: string; reportElement: string }> = {
  NOTES: { concept: 'nt', reportElement: 'SA' },
  MANAGEMENT_REPORT: { concept: 'mgmtRep', reportElement: 'L' },
  AUDIT_REPORT: { concept: 'nt.reportHGB321', reportElement: 'S' },
  TAX_ELECTION_REGISTER: { concept: 'nt.RegisterEStG5Abs1S2', reportElement: 'S' },
}

export function deriveEBalanceReportScope(legalForm: EBalanceLegalForm, profile?: EBalanceReportProfile, taxonomyVersion?: string) {
  const form = E_BALANCE_CORPORATE_ANNUAL_FORM
  if (!form.legalForms.includes(legalForm)) throw new Error('This tax-balance export supports domestic UG, GmbH and AG only.')
  if (taxonomyVersion && !form.taxonomyVersions.includes(taxonomyVersion)) throw new Error('The report form has not been reviewed for this taxonomy release.')
  const source: EBalanceReportProfile = profile ?? form.sourceProfile
  if (Object.entries(form.sourceProfile).some(([key, expected]) => source[key as keyof typeof form.sourceProfile] !== expected)
    || source.specialBalanceRequired || source.supplementaryBalanceRequired) throw new Error('The configured reporting scope requires an unsupported E-Bilanz variant.')
  return { legalForm, sourceAccountingStandard: source.accountingStandard, accountingStandard: 'S' as const,
    incomeStatementMethod: 'GKV' as const, statementType: 'E' as const, reportStatus: 'E' as const,
    consolidationRange: 'EA' as const, incomeClassification: 'trade' as const }
}

const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value === value.trim()
export function validateEBalanceRevision(revision: EBalanceRevision) {
  if (!revision || !E_BALANCE_CORPORATE_ANNUAL_FORM.revisionStatuses.includes(revision.status) || !nonblank(revision.reason)) throw new Error('Explicit report revision status and reason are required.')
  if (revision.status === 'E') {
    if (revision.supersedes !== null) throw new Error('An initial report cannot supersede another report.')
  } else if (!revision.supersedes || !nonblank(revision.supersedes.reportId) || !/^[0-9a-f]{64}$/.test(revision.supersedes.reportChecksum)) {
    throw new Error('A corrected or amended report requires the immutable predecessor ID and checksum.')
  }
}

export function validateEBalanceAttachmentDeclarations(declarations: EBalanceAttachmentDeclaration[]) {
  if (!Array.isArray(declarations) || declarations.length !== E_BALANCE_ATTACHMENT_KINDS.length
    || new Set(declarations.map(row => row.kind)).size !== declarations.length) throw new Error('Declare every applicable attachment, including explicit non-applicability.')
  for (const row of declarations) {
    if (!E_BALANCE_ATTACHMENT_KINDS.includes(row.kind)) throw new Error('Unsupported E-Bilanz attachment kind.')
    if (row.status === 'PRESENT') {
      if (!nonblank(row.text) || !Array.isArray(row.evidenceIds) || !row.evidenceIds.length
        || row.evidenceIds.some(id => !nonblank(id)) || new Set(row.evidenceIds).size !== row.evidenceIds.length) throw new Error('Present attachments require complete text and unique evidence IDs.')
    } else if (row.status !== 'NOT_APPLICABLE' || !nonblank(row.reason)) throw new Error('An omitted attachment requires an explicit non-applicability reason.')
  }
}

export function requireEBalanceAttachmentConcept(model: EBalanceTaxonomyModel, name: string) {
  const concept = model.concepts.get(`gaap:${name}`)
  if (!concept || concept.abstract || concept.prohibited || concept.tuple || concept.type !== 'xbrli:stringItemType' || concept.period !== 'duration') throw new Error(`Attachment ${name} is not supported by taxonomy ${model.release.version}.`)
}
