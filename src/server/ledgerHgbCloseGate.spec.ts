import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('fiscal-year HGB close gate wiring', () => {
  test('given a fiscal close, rechecks the current approved HGB run inside the transaction before creating its successor', async () => {
    const source = await readFile(new URL('./ledger.ts', import.meta.url), 'utf8')
    const claim = source.indexOf("status: { in: ['OPEN', 'REOPENED'] }")
    const gate = source.indexOf('await requireCurrentReadyHgbClose(transaction, ownerId, { id: fiscalYear.id, year })')
    const successor = source.indexOf('const nextYear = year + 1', gate)
    expect(claim).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(claim)
    expect(successor).toBeGreaterThan(gate)
  })

  test('given a ready close, persists the exact HGB run and snapshot before marking the year closed', async () => {
    const source = await readFile(new URL('./ledger.ts', import.meta.url), 'utf8')
    const snapshot = source.indexOf('const snapshot = JSON.stringify')
    const generation = source.indexOf('await createFiscalCloseGeneration(transaction, ownerId, fiscalYear.id, hgbCloseRun, snapshot, lockedAt)', snapshot)
    const closed = source.indexOf("data: { status: 'CLOSED', lockedAt, closingSnapshot: snapshot }", generation)
    expect(snapshot).toBeGreaterThan(-1)
    expect(generation).toBeGreaterThan(snapshot)
    expect(closed).toBeGreaterThan(generation)
  })

  test('given legacy E-Bilanz transport, rechecks and persists the current close generation transactionally', async () => {
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

  test('given an export, rechecks the generation before invoking shared report retention in its write transaction', async () => {
    const source = await readFile(new URL('./ledger.ts', import.meta.url), 'utf8')
    const exportMethod = source.indexOf('export async function exportEBalance')
    const transaction = source.indexOf('await prisma.$transaction(async transaction =>', exportMethod)
    const lockedGate = source.indexOf('await requireCurrentFiscalCloseGeneration(transaction, ownerId, currentFiscalYear)', transaction)
    const retain = source.indexOf('await retainEBalanceReport(transaction,', lockedGate)
    expect(transaction).toBeGreaterThan(exportMethod)
    expect(lockedGate).toBeGreaterThan(transaction)
    expect(retain).toBeGreaterThan(lockedGate)
  })
})
