import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('E-Bilanz lifecycle close-generation gate', () => {
  it('rechecks the exact generation in the write transaction and persists its identity', async () => {
    const source = await readFile(new URL('./eBilanzRepository.ts', import.meta.url), 'utf8')
    const prepare = source.indexOf('export async function prepareEBalanceLifecycleReport')
    const firstGate = source.indexOf('await requireCurrentFiscalCloseGeneration(prisma, ownerId, period)', prepare)
    const transaction = source.indexOf('return await prisma.$transaction(async transaction =>', firstGate)
    const lockedGate = source.indexOf('await requireCurrentFiscalCloseGeneration(transaction, ownerId, currentPeriod)', transaction)
    const binding = source.indexOf('closeGenerationId: currentCloseGeneration.id', lockedGate)
    expect(firstGate).toBeGreaterThan(prepare)
    expect(transaction).toBeGreaterThan(firstGate)
    expect(lockedGate).toBeGreaterThan(transaction)
    expect(binding).toBeGreaterThan(lockedGate)
  })
})
