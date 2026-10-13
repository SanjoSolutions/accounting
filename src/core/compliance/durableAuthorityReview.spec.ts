import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { createAnnualApprovalAuthority, exportAnnualApprovalState, type AnnualApprovalStateSnapshot } from './annualAccounts'
import { createEricSubmissionAuthority, exportEricSubmissionState, type EricSubmissionStateSnapshot } from './eBilanzLifecycle'

type Snapshot = AnnualApprovalStateSnapshot | EricSubmissionStateSnapshot
const signer = (keyId: string) => ({
  keyId,
  sign: (payload: string) => createHmac('sha256', `synthetic-test-material-${keyId}`).update(payload).digest('hex'),
  verify(payload: string, signature: string, signedBy: string) { return signedBy === keyId && signature === this.sign(payload) },
})

/** Test-only adapter: one stream per database, independent of signing key. */
function durableStore(path: string) {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE IF NOT EXISTS head (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, snapshot TEXT NOT NULL)')
  return {
    close: () => db.close(),
    currentRevision: (_keyId: string) => Number((db.prepare('SELECT revision FROM head WHERE id = 1').get() as { revision: number } | undefined)?.revision ?? 0),
    read: () => JSON.parse(String(db.prepare('SELECT snapshot FROM head WHERE id = 1').get()!.snapshot)) as Snapshot,
    commitSnapshot: (_keyId: string, expectedRevision: number, snapshot: Snapshot) => {
      if (snapshot.revision !== expectedRevision + 1) return false
      const bytes = JSON.stringify(snapshot)
      const result = expectedRevision === 0
        ? db.prepare('INSERT OR IGNORE INTO head VALUES (1, ?, ?)').run(snapshot.revision, bytes)
        : db.prepare('UPDATE head SET revision = ?, snapshot = ? WHERE id = 1 AND revision = ?').run(snapshot.revision, bytes, expectedRevision)
      return result.changes === 1
    },
  }
}

describe('independent durable authority contract review', () => {
  for (const kind of ['annual', 'eric'] as const) {
    test(`Given ${kind} workers sharing durable storage, when restarted, raced and rotated, then only the committed monotonic head can be hydrated`, () => {
      const directory = mkdtempSync(join(tmpdir(), 'accounting-authority-review-'))
      const path = join(directory, 'disposable.db')
      let store = durableStore(path)
      const oldSigner = signer('old-key'); const newSigner = signer('new-key')
      const create = (snapshot?: Snapshot, auth = oldSigner) => kind === 'annual'
        ? createAnnualApprovalAuthority(snapshot as AnnualApprovalStateSnapshot | undefined, auth, store)
        : createEricSubmissionAuthority(snapshot as EricSubmissionStateSnapshot | undefined, auth, store)
      const save = (authority: ReturnType<typeof create>, auth = oldSigner, target = store) => kind === 'annual'
        ? exportAnnualApprovalState(authority as ReturnType<typeof createAnnualApprovalAuthority>, auth, target)
        : exportEricSubmissionState(authority as ReturnType<typeof createEricSubmissionAuthority>, auth, target)
      try {
        const first = save(create())
        store.close()
        // A fresh process sees the exact signed bytes and revision after restart.
        const process = spawnSync(globalThis.process.execPath, ['--input-type=module', '-e', "import {DatabaseSync} from 'node:sqlite'; const db = new DatabaseSync(process.argv[1]); console.log(db.prepare('SELECT snapshot FROM head WHERE id = 1').get().snapshot); db.close()", path], { encoding: 'utf8' })
        expect(process.status).toBe(0)
        expect(JSON.parse(process.stdout)).toEqual(first)
        store = durableStore(path)
        const workerA = create(store.read()); const workerB = create(store.read())
        const second = save(workerA)
        expect(() => save(workerB)).toThrow(/stale/)
        expect(store.read()).toEqual(second)
        expect(() => create(first)).toThrow(/stale/)

        const rotatingWorker = create(second)
        const rotated = save(rotatingWorker, newSigner)
        expect(rotated.revision).toBe(3)
        expect(() => create(first, oldSigner)).toThrow(/stale/)
        expect(() => create(second, oldSigner)).toThrow(/stale/)
        expect(() => create(rotated, newSigner)).not.toThrow()
        expect(() => create(rotated, oldSigner)).toThrow(/authenticity|signature/)

        const retryingWorker = create(rotated, newSigner)
        expect(() => save(retryingWorker, newSigner, { ...store, commitSnapshot: () => { throw new Error('synthetic storage failure') } })).toThrow(/storage failure/)
        expect(store.read()).toEqual(rotated)
        expect(save(retryingWorker, newSigner).revision).toBe(4)
        expect(() => save(create(), newSigner)).toThrow(/stale/)
      } finally {
        store.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }
})
