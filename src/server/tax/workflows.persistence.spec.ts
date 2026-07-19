import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DeclarationDataset } from '@/core/taxDeclarations'
import { declarationDatasetHash } from '@/core/taxDeclarations'

const currentVatDatasets = vi.hoisted(() => new Map<string, DeclarationDataset>())
vi.mock('server-only', () => ({}))
vi.mock('./vatRepository', () => ({ currentReconciledVatDataset: vi.fn(async (ownerId: string, period: string) => {
  const prepared = currentVatDatasets.get(`${ownerId}:${period}`)
  if (!prepared) throw new Error(`Missing current VAT dataset for ${period}`)
  return { reconciliation: { ok: true }, dataset: prepared }
}) }))
const directory = mkdtempSync(join(tmpdir(), 'accounting-tax-workflows-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./workflows')
let prisma: typeof import('@/server/persistence/client').prisma
let submitOutcome: 'accepted' | 'uncertain' = 'accepted'
let correctOutcome: 'accepted' | 'uncertain' = 'accepted'
let validationFails = false
let submitThrows = false
const calls = { submit: 0, correct: 0, cancel: 0, recover: 0 }

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const root = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  api = await import('./workflows')
  prisma = (await import('@/server/persistence/client')).prisma
  const { declarationDatasetHash } = await import('@/core/taxDeclarations')
  for (const [period, amount] of [['2026-01', 1900], ['2026-01', 1800], ['2026-02', 700], ['2026-03', 800], ['2026-04', 900], ['2026-05', 1100], ['2026-05', 1000], ['2026-06', 600], ['2026-06', 500], ['2026-07', 1200], ['2026-08', 1400]] as const) {
    const prepared = api.prepareTenantDataset('tenant-a', dataset(amount))
    const canonical = { ...prepared, period }
    const datasetHash = declarationDatasetHash(canonical)
    await prisma.taxDatasetPreparationRecord.create({ data: { ownerId: 'tenant-a', kind: canonical.kind, period, datasetHash } })
    currentVatDatasets.set(`tenant-a:${period}`, canonical)
  }
  currentVatDatasets.set('tenant-a:2026-01', api.prepareTenantDataset('tenant-a', { ...dataset(1900), period: '2026-01' }))
  currentVatDatasets.set('tenant-a:2026-05', api.prepareTenantDataset('tenant-a', { ...dataset(1100), period: '2026-05' }))
  currentVatDatasets.set('tenant-a:2026-06', api.prepareTenantDataset('tenant-a', { ...dataset(600), period: '2026-06' }))
  api.setOfficialTaxGatewayForTests({
    validate: async () => validationFails ? { valid: false, errors: ['schema-failed'], protocol: 'schema-failed' } : { valid: true, errors: [], protocol: 'schema-ok' },
    submit: async (_dataset, key) => { calls.submit++; if (submitThrows) throw new Error('transport failed'); return submitOutcome === 'accepted' ? { outcome: 'accepted', receipt: `receipt:${key}` } : { outcome: 'uncertain' } },
    correct: async (_target, _dataset, key) => { calls.correct++; return correctOutcome === 'accepted' ? { outcome: 'accepted', receipt: `correction:${key}` } : { outcome: 'uncertain' } },
    cancel: async (_target, key) => { calls.cancel++; return { outcome: 'accepted', receipt: `cancellation:${key}` } },
    recover: async key => { calls.recover++; return { outcome: 'accepted', receipt: `recovered:${key}` } },
  })
})
afterAll(async () => { await prisma.$disconnect(); delete process.env.DATABASE_URL; rmSync(directory, { recursive: true, force: true }) })

const dataset = (amount: number) => ({ kind: 'USTVA' as const, period: '2026-01', fields: { ZAHLLAST: amount }, drilldown: { ZAHLLAST: ['entry-1', 'document-1'] } })

describe('durable official tax workflow integration', () => {
  it('rejects binding annual datasets that did not pass tenant-scoped preparation', async () => {
    await expect(api.submitTaxDataset('tenant-a', 'approver-a', 'annual-unprepared-key', { kind: 'KST', period: '2026', fields: { STEUERLICHES_ERGEBNIS: 100, KST_SCHULD: 15 }, drilldown: {} })).rejects.toThrow(/fiscal year|company-profile/)
  })
  it('persists approval, receipt and immutable events and makes external request keys idempotent', async () => {
    const first = await api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-0001', dataset(1900))
    const retry = await api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-0001', dataset(1900))
    currentVatDatasets.set('tenant-a:2026-01', api.prepareTenantDataset('tenant-a', dataset(1950)))
    const replayAfterSourceChange = await api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-0001', dataset(1900))
    currentVatDatasets.set('tenant-a:2026-01', api.prepareTenantDataset('tenant-a', dataset(1900)))
    expect(first).toMatchObject({ state: 'accepted', receipt: expect.stringContaining('receipt:') })
    expect(retry.submissionId).toBe(first.submissionId)
    expect(replayAfterSourceChange.submissionId).toBe(first.submissionId)
    expect(calls.submit).toBe(1)
    expect(first.events.map(item => item.type)).toEqual(expect.arrayContaining(['official-validation-passed', 'approved', 'submission-started', 'submission-accepted']))
    expect(await api.listTaxWorkflows('tenant-b')).toEqual([])
  })
  it('fails closed instead of exposing tampered official history', async () => {
    const row = await prisma.taxWorkflowRecord.findFirstOrThrow({ where: { ownerId: 'tenant-a' } })
    const tampered = JSON.parse(row.payload); tampered.snapshot.receipt = 'forged'
    await prisma.taxWorkflowRecord.update({ where: { submissionId: row.submissionId }, data: { payload: JSON.stringify(tampered) } })
    await expect(api.listTaxWorkflows('tenant-a')).rejects.toThrow(/integrity/)
    await expect(api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-0001', dataset(1900))).rejects.toThrow(/integrity/)
    await prisma.taxWorkflowRecord.update({ where: { submissionId: row.submissionId }, data: { payload: row.payload } })
  })

  it('does not silently truncate immutable filing history', async () => {
    const findMany = vi.spyOn(prisma.taxWorkflowRecord, 'findMany')
    await api.listTaxWorkflows('tenant-a')
    expect(findMany).toHaveBeenLastCalledWith({ where: { ownerId: 'tenant-a' }, orderBy: [{ updatedAt: 'desc' }, { submissionId: 'desc' }] })
    findMany.mockRestore()
  })

  it('archives an accepted correction and atomically finalizes its original', async () => {
    const original = (await api.listTaxWorkflows('tenant-a'))[0]
    const originalBeforeCorrection = await prisma.taxWorkflowRecord.findUniqueOrThrow({ where: { submissionId: original.submissionId } })
    currentVatDatasets.set('tenant-a:2026-01', api.prepareTenantDataset('tenant-a', dataset(1800)))
    const correction = await api.correctTaxWorkflow('tenant-a', 'approver-a', original.submissionId, 'correction-request-0001', dataset(1800))
    expect(correction).toMatchObject({ state: 'accepted', correctsId: original.submissionId, receipt: expect.stringContaining('correction:') })
    expect(calls.correct).toBe(1)
    const history = await api.listTaxWorkflows('tenant-a')
    expect(history.find(item => item.submissionId === original.submissionId)?.state).toBe('corrected')
    await prisma.taxWorkflowRecord.update({ where: { submissionId: original.submissionId }, data: { state: originalBeforeCorrection.state, revision: originalBeforeCorrection.revision, payload: originalBeforeCorrection.payload, receipt: originalBeforeCorrection.receipt, actionReservation: originalBeforeCorrection.actionReservation } })
    const replay = await api.correctTaxWorkflow('tenant-a', 'approver-a', original.submissionId, 'correction-request-0001', dataset(1800))
    expect(replay.submissionId).toBe(correction.submissionId)
    expect((await api.listTaxWorkflows('tenant-a')).find(item => item.submissionId === original.submissionId)?.state).toBe('corrected')
    expect(calls.correct).toBe(1)
    await expect(api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-duplicate', dataset(1800))).rejects.toThrow(/original declaration already exists/)
    const secondOriginal = await api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-0003', { ...dataset(600), period: '2026-06' })
    currentVatDatasets.set('tenant-a:2026-06', api.prepareTenantDataset('tenant-a', { ...dataset(500), period: '2026-06' }))
    await expect(api.correctTaxWorkflow('tenant-a', 'approver-a', secondOriginal.submissionId, 'correction-request-0001', { ...dataset(500), period: '2026-06' })).rejects.toThrow(/different declaration dataset/)
  })

  it('persists cancellation receipts and recovers uncertain outcomes without retransmission', async () => {
    const correction = (await api.listTaxWorkflows('tenant-a')).find(item => item.correctsId)!
    const cancelled = await api.cancelTaxWorkflow('tenant-a', 'approver-a', correction.submissionId)
    expect(cancelled).toMatchObject({ state: 'cancelled', receipt: expect.stringContaining('cancellation:') })
    const replacement = await api.submitTaxDataset('tenant-a', 'approver-a', 'replacement-after-cancel', dataset(1800))
    expect(replacement.state).toBe('accepted')
    submitOutcome = 'uncertain'
    const uncertain = await api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-0002', { ...dataset(700), period: '2026-02' })
    expect(uncertain.state).toBe('uncertain')
    const recovered = await api.recoverTaxWorkflow('tenant-a', uncertain.submissionId)
    expect(recovered).toMatchObject({ state: 'accepted', receipt: expect.stringContaining('recovered:') })
    expect(calls.recover).toBe(1)
  })

  it('reclaims a failed pre-transmission request and preserves one deterministic submission identity', async () => {
    submitOutcome = 'accepted'
    validationFails = true
    await expect(api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-failed', { ...dataset(800), period: '2026-03' })).rejects.toThrow(/schema-failed/)
    validationFails = false
    const recovered = await api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-failed', { ...dataset(800), period: '2026-03' })
    expect(recovered).toMatchObject({ state: 'accepted' })
    expect((await prisma.taxSubmissionRequest.findUnique({ where: { ownerId_requestKey: { ownerId: 'tenant-a', requestKey: 'submission-request-failed' } } }))?.submissionId).toBe(recovered.submissionId)
  })
  it('reclaims a stale workflow-less filing reservation after the client loses its request key', async () => {
    const input = { ...dataset(1500), period: '2026-09' }
    const prepared = api.prepareTenantDataset('tenant-a', input)
    currentVatDatasets.set('tenant-a:2026-09', prepared)
    await prisma.taxDatasetPreparationRecord.create({ data: { ownerId: 'tenant-a', kind: prepared.kind, period: prepared.period, datasetHash: declarationDatasetHash(prepared) } })
    const filingKey = createHash('sha256').update('tenant-a\u0000USTVA\u00002026-09').digest('hex')
    const stale = await prisma.taxSubmissionRequest.create({ data: { ownerId: 'tenant-a', requestKey: 'lost-browser-request-key', datasetHash: 'stale-preflight', submissionId: 'no-workflow-was-created', filingKey } })
    await prisma.taxSubmissionRequest.update({ where: { id: stale.id }, data: { updatedAt: new Date(Date.now() - 6 * 60_000) } })
    await expect(api.submitTaxDataset('tenant-a', 'approver-a', 'replacement-browser-key', input)).resolves.toMatchObject({ state: 'accepted' })
    expect(await prisma.taxSubmissionRequest.findUnique({ where: { id: stale.id } })).toMatchObject({ requestKey: 'replacement-browser-key', status: 'ACCEPTED' })
  })

  it('associates an externally uncertain transport failure with a recoverable persisted workflow', async () => {
    const transmissionsBefore = calls.submit
    submitThrows = true
    await expect(api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-transport', { ...dataset(900), period: '2026-04' })).rejects.toThrow(/transport failed/)
    submitThrows = false
    const associated = await api.submitTaxDataset('tenant-a', 'approver-a', 'submission-request-transport', { ...dataset(900), period: '2026-04' })
    expect(associated.state).toBe('submitting')
    expect(calls.submit).toBe(transmissionsBefore + 1)
    await expect(api.recoverTaxWorkflow('tenant-a', associated.submissionId)).resolves.toMatchObject({ state: 'accepted' })
  })
  it('finalizes the original when an uncertain correction becomes accepted during recovery', async () => {
    submitOutcome = 'accepted'; correctOutcome = 'uncertain'
    const original = await api.submitTaxDataset('tenant-a', 'approver-a', 'submission-recovery-original', { ...dataset(1100), period: '2026-05' })
    currentVatDatasets.set('tenant-a:2026-05', api.prepareTenantDataset('tenant-a', { ...dataset(1000), period: '2026-05' }))
    const correction = await api.correctTaxWorkflow('tenant-a', 'approver-a', original.submissionId, 'correction-recovery-key', { ...dataset(1000), period: '2026-05' })
    expect(correction.state).toBe('uncertain')
    await expect(api.recoverTaxWorkflow('tenant-a', correction.submissionId)).resolves.toMatchObject({ state: 'accepted' })
    expect((await api.listTaxWorkflows('tenant-a')).find(item => item.submissionId === original.submissionId)?.state).toBe('corrected')
    correctOutcome = 'accepted'
  })
  it('rejects a once-prepared VAT dataset after its current reconciled sources change', async () => {
    currentVatDatasets.set('tenant-a:2026-07', api.prepareTenantDataset('tenant-a', { ...dataset(1300), period: '2026-07' }))
    await expect(api.submitTaxDataset('tenant-a', 'approver-a', 'submission-stale-source', { ...dataset(1200), period: '2026-07' })).rejects.toThrow(/sources changed after preparation/)
  })
  it('rejects assessment cents outside the persisted signed integer range', async () => {
    await expect(api.recordTaxAssessment('tenant-a', { assessedAmountCents: 2_147_483_648 } as never)).rejects.toThrow(/32-bit/)
  })
  it('atomically permits only one original request for a tenant form period', async () => {
    const submissionsBefore = calls.submit
    const input = { ...dataset(1400), period: '2026-08' }
    const results = await Promise.allSettled([
      api.submitTaxDataset('tenant-a', 'approver-a', 'concurrent-original-request-a', input),
      api.submitTaxDataset('tenant-a', 'approver-a', 'concurrent-original-request-b', input),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(calls.submit).toBe(submissionsBefore + 1)
  })
})
