import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('fiscal-year HGB close gate wiring', () => {
  it('rechecks the current approved HGB run inside the transaction after claiming the year and before creating its successor', async () => {
    const source = await readFile(new URL('./ledger.ts', import.meta.url), 'utf8')
    const claim = source.indexOf("status: { in: ['OPEN', 'REOPENED'] }")
    const gate = source.indexOf('await requireCurrentReadyHgbClose(transaction, ownerId, { id: fiscalYear.id, year })')
    const successor = source.indexOf('const nextYear = year + 1', gate)
    expect(claim).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(claim)
    expect(successor).toBeGreaterThan(gate)
  })

  it('persists the exact HGB run and snapshot as a close generation before marking the year closed', async () => {
    const source = await readFile(new URL('./ledger.ts', import.meta.url), 'utf8')
    const snapshot = source.indexOf('const snapshot = JSON.stringify')
    const generation = source.indexOf('await createFiscalCloseGeneration(transaction, ownerId, fiscalYear.id, hgbCloseRun, snapshot, lockedAt)', snapshot)
    const closed = source.indexOf("data: { status: 'CLOSED', lockedAt, closingSnapshot: snapshot }", generation)
    expect(snapshot).toBeGreaterThan(-1)
    expect(generation).toBeGreaterThan(snapshot)
    expect(closed).toBeGreaterThan(generation)
  })

  it('rechecks and persists the current close generation transactionally for legacy E-Bilanz transport', async () => {
    const source = await readFile(new URL('./ledger.ts', import.meta.url), 'utf8')
    const transport = source.indexOf('export async function processEBalanceWithEric')
    const gate = source.indexOf('await requireCurrentFiscalCloseGeneration(prisma, ownerId, fiscalYear)', transport)
    const transaction = source.indexOf('attempt = await prisma.$transaction(async transaction =>', gate)
    const lockedGate = source.indexOf('await requireCurrentFiscalCloseGeneration(transaction, ownerId, currentFiscalYear)', transaction)
    const persistedBinding = source.indexOf('closeGenerationId: currentCloseGeneration.id', lockedGate)
    expect(gate).toBeGreaterThan(transport)
    expect(transaction).toBeGreaterThan(gate)
    expect(lockedGate).toBeGreaterThan(transaction)
    expect(persistedBinding).toBeGreaterThan(lockedGate)
  })

  it('rechecks exports in their write transaction and reuses lifecycle reports only within the exact generation', async () => {
    const source = await readFile(new URL('./ledger.ts', import.meta.url), 'utf8')
    const exportMethod = source.indexOf('export async function exportEBalance')
    const transaction = source.indexOf('await prisma.$transaction(async transaction =>', exportMethod)
    const lockedGate = source.indexOf('await requireCurrentFiscalCloseGeneration(transaction, ownerId, currentFiscalYear)', transaction)
    const exactReuse = source.indexOf('fiscalYearId: fiscalYear.id, closeGenerationId: currentCloseGeneration.id, reportChecksum', lockedGate)
    expect(transaction).toBeGreaterThan(exportMethod)
    expect(lockedGate).toBeGreaterThan(transaction)
    expect(exactReuse).toBeGreaterThan(lockedGate)
  })
})
