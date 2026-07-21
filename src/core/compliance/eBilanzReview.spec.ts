import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  createAmendedSubmission, createEricSubmissionAuthority, exportEricSubmissionState,
  recordSubmissionReceipt, type EBalanceSubmissionVersion, type EricSubmissionStateSnapshot,
} from './eBilanzLifecycle'

function fixtures() {
  let revision = 0
  const authenticator = {
    keyId: 'eric-state-key-1',
    sign: (payload: string) => createHash('sha256').update(`test-key:${payload}`).digest('hex'),
    verify(payload: string, signature: string, keyId: string) { return keyId === this.keyId && signature === this.sign(payload) },
  }
  const revisionStore = {
    currentRevision: () => revision,
    commitSnapshot(_keyId: string, expectedRevision: number, snapshot: EricSubmissionStateSnapshot) {
      if (revision !== expectedRevision || snapshot.revision !== expectedRevision + 1) return false
      revision = snapshot.revision
      return true
    },
  }
  return { authenticator, revisionStore, setRevision: (value: number) => { revision = value } }
}

function accepted(authority: ReturnType<typeof createEricSubmissionAuthority>) {
  const prepared: EBalanceSubmissionVersion = { id: 'submission-1', version: 1, reportChecksum: 'report-hash-1', status: 'PREPARED' }
  return recordSubmissionReceipt(prepared, {
    receivedAt: '2026-07-21T12:00:00Z', transmissionId: 'transmission-1', reportChecksum: prepared.reportChecksum,
    status: 'ACCEPTED', diagnostics: [{ code: 'ERIC_OK', severity: 'INFO', message: 'Accepted' }],
  }, authority)
}

describe('durable ERiC submission authority review regressions', () => {
  it('rehydrates accepted receipts and transmission ownership after a process boundary', () => {
    const fixture = fixtures(); const authority = createEricSubmissionAuthority(); const original = accepted(authority)
    const snapshot = exportEricSubmissionState(authority, fixture.authenticator, fixture.revisionStore)
    const restored = createEricSubmissionAuthority(structuredClone(snapshot), fixture.authenticator, fixture.revisionStore)
    expect(createAmendedSubmission(original, 'report-hash-2', restored).amendment).toMatchObject({ version: 2, supersedesId: original.id, status: 'PREPARED' })
  })

  it('rejects replayed snapshots, tampering, and concurrent stale commits', () => {
    const fixture = fixtures(); const authority = createEricSubmissionAuthority(); accepted(authority)
    const first = exportEricSubmissionState(authority, fixture.authenticator, fixture.revisionStore)
    const workerA = createEricSubmissionAuthority(first, fixture.authenticator, fixture.revisionStore)
    const workerB = createEricSubmissionAuthority(first, fixture.authenticator, fixture.revisionStore)
    exportEricSubmissionState(workerA, fixture.authenticator, fixture.revisionStore)
    expect(() => exportEricSubmissionState(workerB, fixture.authenticator, fixture.revisionStore)).toThrow('rejected as stale')
    expect(() => createEricSubmissionAuthority(first, fixture.authenticator, fixture.revisionStore)).toThrow('revision is stale')
    fixture.setRevision(first.revision)
    const tampered = structuredClone(first); tampered.transmissions[0].submissionId = 'other-submission'
    expect(() => createEricSubmissionAuthority(tampered, fixture.authenticator, fixture.revisionStore)).toThrow('signature verification failed')
  })
})
