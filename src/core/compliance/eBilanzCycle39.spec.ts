import { describe, expect, it } from 'vitest'
import { canonicalJson } from './auditExport'
import { createAmendedSubmission, createEBalanceAssetAttachments, createEBalancePayloadEvidence, createEBalanceReport, createEBalanceSemanticFacts, createEricSubmissionAuthority, planTaxonomyUpgrade, recordSubmissionReceipt, selectTaxonomy, validateWithEric, type EBalanceProfile, type TaxonomyRelease } from './eBilanzLifecycle'

const profile: EBalanceProfile = { tenantId: 'tenant-cycle-39', companyName: 'Example GmbH', legalForm: 'GMBH', taxNumber: '1234567890', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }
const taxonomy: TaxonomyRelease = { version: '6.10', validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31', gaapNamespace: 'gaap-6.10', gcdNamespace: 'gcd-6.10', entryPoint: '6.10.xsd', archiveSha256: 'a'.repeat(64) }
let representedPayload: unknown = {}
const serializer = { serialize: (payload: Readonly<Record<string, unknown>>) => { representedPayload = payload; return `<xbrl xmlns="http://www.xbrl.org/2003/instance">${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` }, parseRoot: () => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance', representedPayload }) }
const facts = [{ concept: 'is.netIncome', context: 'duration' as const, amountCents: 0, unit: 'EUR' as const, accountIds: [] }]
const prepared = { id: 'submission-1', version: 1, reportChecksum: 'report-sha', status: 'PREPARED' as const }
const receipt = { receivedAt: '2026-07-18T10:00:00Z', transmissionId: 'ERIC-1', reportChecksum: 'report-sha', status: 'ACCEPTED' as const, diagnostics: [] }

describe('cycle 39 E-Bilanz runtime contract hardening', () => {
  it('requires receipt diagnostics to be an actual array of canonical records', () => {
    const authority = createEricSubmissionAuthority()
    for (const diagnostics of [undefined, null, 'none', {}, true, [{ code: '', severity: 'error', message: 'bad' }], [{ code: 'E1', severity: '', message: 'bad' }], [{ code: 'E1', severity: 'error', message: '' }], [{ code: 'E1', severity: 'error', message: 'bad', path: 1 }]]) expect(() => recordSubmissionReceipt(prepared, { ...receipt, diagnostics } as never, authority)).toThrow('diagnostics must be an array')
    expect(recordSubmissionReceipt(prepared, { ...receipt, diagnostics: [{ code: 'E1', severity: 'error', message: 'Invalid fact', path: '/xbrl/fact' }] }, authority).status).toBe('ACCEPTED')
  })

  it('does not amend an accepted submission whose immutable receipt omits or corrupts diagnostics', () => {
    const authority = createEricSubmissionAuthority()
    for (const diagnostics of [undefined, 'none', {}, [{ code: 'E1', severity: 'error' }]]) {
      const immutableReceipt = canonicalJson({ receivedAt: receipt.receivedAt, transmissionId: receipt.transmissionId, reportChecksum: receipt.reportChecksum, status: 'ACCEPTED', ...(diagnostics !== undefined ? { diagnostics } : {}) })
      expect(() => createAmendedSubmission({ ...prepared, status: 'ACCEPTED', immutableReceipt }, 'new-report', authority)).toThrow('diagnostics must be an array')
    }
    const accepted = recordSubmissionReceipt(prepared, receipt, authority)
    expect(createAmendedSubmission(accepted, 'new-report', authority).amendment.supersedesId).toBe(prepared.id)
  })

  it('requires strict boolean supporting-balance flags before rule-driving checks', () => {
    for (const field of ['specialBalanceRequired', 'supplementaryBalanceRequired'] as const) for (const value of [0, 1, 'false', 'true', null, {}]) expect(() => createEBalanceReport({ ...profile, [field]: value } as never, taxonomy, facts, [], createEBalanceAssetAttachments(profile), serializer)).toThrow('must be strict booleans')
    expect(() => createEBalanceReport({ ...profile, specialBalanceRequired: false, supplementaryBalanceRequired: false }, taxonomy, facts, [], createEBalanceAssetAttachments(profile), serializer)).not.toThrow()
  })

  it('canonicalizes registry version and successor strings once for selection and upgrade lookup', () => {
    const registry: TaxonomyRelease[] = [{ ...taxonomy, version: ' 6.9 ', successorVersion: ' 7.0 ' }, { ...taxonomy, version: ' 7.0 ', successorVersion: undefined }]
    expect(planTaxonomyUpgrade(registry, ' 6.9 ')?.version).toBe('7.0')
    expect(selectTaxonomy(registry, profile.fiscalPeriodStart, ' 7.0 ').version).toBe('7.0')
    expect(registry[0].version).toBe(' 6.9 ')
    expect(registry[0].successorVersion).toBe(' 7.0 ')
  })

  it('rejects malformed ERiC adapter responses with controlled contract errors', async () => {
    const report = createEBalanceReport(profile, taxonomy, facts, [], createEBalanceAssetAttachments(profile), serializer)
    for (const response of [null, true, {}, { valid: 1, engineVersion: 'ERIC-1', diagnostics: [] }, { valid: true, engineVersion: '', diagnostics: [] }, { valid: true, engineVersion: 'ERIC-1' }, { valid: true, engineVersion: 'ERIC-1', diagnostics: 'none' }, { valid: true, engineVersion: 'ERIC-1', diagnostics: [{ code: 'E1', severity: 'error' }] }]) {
      await expect(validateWithEric(report, { validate: async () => response as never }, '2026-07-18T10:00:00Z')).rejects.toThrow(/malformed response contract|diagnostics must be an array/)
    }
    await expect(validateWithEric(report, { validate: async () => ({ valid: false, engineVersion: 'ERIC-1', diagnostics: [{ code: 'E1', severity: 'error', message: 'Invalid fact' }] }) }, '2026-07-18T10:00:00Z')).resolves.toMatchObject({ valid: false, engineVersion: 'ERIC-1', diagnostics: [{ code: 'E1', reportChecksum: report.checksum }] })
  })
})
