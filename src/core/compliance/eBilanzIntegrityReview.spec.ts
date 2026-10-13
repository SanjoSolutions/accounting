import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { canonicalJson } from './auditExport'
import {
  createAmendedSubmission, createEBalanceAssetAttachments, createEBalancePayloadEvidence,
  createEBalanceReport, createEBalanceSemanticFacts, createEricSubmissionAuthority,
  exportEricSubmissionState, finalizeAmendedSubmission, recordSubmissionReceipt,
  type EBalanceProfile, type EricSubmissionStateSnapshot, type TaxonomyRelease,
} from './eBilanzLifecycle'

const profile: EBalanceProfile = { tenantId: 'review-tenant', companyName: 'Synthetic UG', legalForm: 'UG', taxNumber: '1234567890', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }
const taxonomy: TaxonomyRelease = { version: '6.9', validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31', gaapNamespace: 'urn:review:gaap', gcdNamespace: 'urn:review:gcd', entryPoint: 'review.xsd', archiveSha256: 'a'.repeat(64) }
const facts = [{ concept: 'is.netIncome', context: 'duration' as const, amountCents: 0, unit: 'EUR' as const, accountIds: [] }]
const serializer = {
  serialize: (payload: Readonly<Record<string, unknown>>) => `<xbrl xmlns="http://www.xbrl.org/2003/instance">${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>`,
  parseRoot: () => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance' }),
}

function stateFixture() {
  const authenticator = {
    keyId: 'disposable-review-key',
    sign: (payload: string) => createHmac('sha256', 'synthetic-review-key-not-a-real-secret').update(payload).digest('hex'),
    verify(payload: string, signature: string, keyId: string) { return keyId === this.keyId && signature === this.sign(payload) },
  }
  const store = { currentRevision: () => 1, commitSnapshot: () => true }
  const authority = createEricSubmissionAuthority()
  const original = recordSubmissionReceipt({ id: 'original', version: 1, reportChecksum: 'original-hash', status: 'PREPARED' }, { receivedAt: '2027-02-01T10:00:00Z', transmissionId: 'transmission-1', reportChecksum: 'original-hash', status: 'ACCEPTED', diagnostics: [] }, authority)
  const amendment = createAmendedSubmission(original, 'amended-hash', authority).amendment
  const finalized = finalizeAmendedSubmission(original, amendment, { receivedAt: '2027-02-02T10:00:00Z', transmissionId: 'transmission-2', reportChecksum: amendment.reportChecksum, status: 'ACCEPTED', diagnostics: [] }, authority)
  const snapshot = structuredClone(exportEricSubmissionState(authority, authenticator, store))
  const hydrate = (value: EricSubmissionStateSnapshot) => {
    const { authenticity: _old, ...payload } = value
    return createEricSubmissionAuthority({ ...payload, authenticity: { keyId: authenticator.keyId, signature: authenticator.sign(canonicalJson(payload)) } }, authenticator, store)
  }
  return { snapshot, hydrate, finalized }
}

describe('independent issue 20 XML and authenticated hydration review', () => {
  test.each(['\u0000', '\u0001', '\u000b', '\ufffe', '\ud800'])('Given an invalid XML character %j, when a serializer claims valid XML, then the report is rejected independently', character => {
    const invalidProfile = { ...profile, tenantId: `review${character}tenant` }
    expect(() => createEBalanceReport(invalidProfile, taxonomy, facts, [], createEBalanceAssetAttachments(invalidProfile), serializer)).toThrow(/XML/)
  })

  test('Given valid escaped characters and Unicode, when a canonical report is generated, then the retained bytes and checksum remain valid', () => {
    const escaped = { ...profile, tenantId: 'review<&>"ä😀' }
    const report = createEBalanceReport(escaped, taxonomy, facts, [], createEBalanceAssetAttachments(escaped), serializer)
    expect(Buffer.from(report.transmittedBytes).toString('utf8')).toBe(report.content)
  })

  test.each([
    ['an orphan amendment', (s: EricSubmissionStateSnapshot) => { s.submissions.find(x => x.status === 'ACCEPTED')!.supersedesId = 'missing' }],
    ['two active versions', (s: EricSubmissionStateSnapshot) => { s.submissions.find(x => x.status === 'SUPERSEDED')!.status = 'ACCEPTED' }],
    ['a superseded leaf', (s: EricSubmissionStateSnapshot) => { s.submissions.find(x => x.status === 'ACCEPTED')!.status = 'SUPERSEDED' }],
    ['a padded parent ID', (s: EricSubmissionStateSnapshot) => { s.submissions.find(x => x.status === 'ACCEPTED')!.supersedesId = ' original ' }],
    ['a skipped attempt version', (s: EricSubmissionStateSnapshot) => { s.submissions.find(x => x.status === 'ACCEPTED')!.version = 3 }],
    ['a receipt predating its predecessor', (s: EricSubmissionStateSnapshot) => {
      const child = s.submissions.find(x => x.status === 'ACCEPTED')!
      child.immutableReceipt = canonicalJson({ ...JSON.parse(child.immutableReceipt!), receivedAt: '2027-01-01T10:00:00Z' })
    }],
    ['noncanonical receipt bytes', (s: EricSubmissionStateSnapshot) => {
      const child = s.submissions.find(x => x.status === 'ACCEPTED')!
      child.immutableReceipt = JSON.stringify(JSON.parse(child.immutableReceipt!), null, 2)
    }],
  ] as const)('Given a correctly signed snapshot containing %s, when it is hydrated, then impossible lifecycle state is rejected', (_label, mutate) => {
    const fixture = stateFixture()
    mutate(fixture.snapshot)
    expect(() => fixture.hydrate(fixture.snapshot)).toThrow(/supersession|receipt|canonical/i)
  })

  test('Given a valid supersession chain in reverse storage order, when it is hydrated, then the accepted successor can be amended', () => {
    const fixture = stateFixture()
    const restored = fixture.hydrate({ ...fixture.snapshot, submissions: [...fixture.snapshot.submissions].reverse() })
    expect(createAmendedSubmission(fixture.finalized.amendment, 'third-hash', restored).amendment.version).toBe(3)
  })
})
