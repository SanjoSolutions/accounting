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
})
