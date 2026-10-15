import 'server-only'

import type { FiscalCloseGeneration, Prisma } from '@/generated/prisma/client'
import { createOpeningBalanceLines, type FinancialStatements } from '@/core/doubleEntry'
import { createOpeningBalanceDeltaLines } from '@/core/openingBalanceDelta'

/** Called inside the close transaction, after its successor lock/topology checks. */
export async function carryForwardFiscalClose(
  transaction: Prisma.TransactionClient,
  closeGeneration: FiscalCloseGeneration,
  predecessorYear: number,
  successor: { id: string; year: number; startsAt: Date },
  statements: FinancialStatements,
) {
  const { ownerId, fiscalYearId } = closeGeneration
  const openingKey = `OPENING:${fiscalYearId}`
  const generations = await transaction.fiscalCloseGeneration.findMany({
    where: { ownerId, fiscalYearId }, select: { id: true },
  })
  // Include the immutable legacy opening, but never successor business activity
  // or carry-forwards belonging to another predecessor or tenant.
  const prior = await transaction.journalEntry.findMany({
    where: {
      ownerId, fiscalYearId: successor.id, source: 'OPENING',
      externalKey: { in: [openingKey, ...generations.map(generation => `${openingKey}:${generation.id}`)] },
    },
    include: { lines: true },
  })
  const lines = createOpeningBalanceDeltaLines(createOpeningBalanceLines(statements), prior.flatMap(entry => entry.lines))
  if (!lines.length) return null

  const last = await transaction.journalEntry.findFirst({
    where: { fiscalYearId: successor.id }, orderBy: { sequenceNumber: 'desc' }, select: { sequenceNumber: true },
  })
  return transaction.journalEntry.create({ data: {
    ownerId, fiscalYearId: successor.id, sequenceNumber: (last?.sequenceNumber ?? 0) + 1,
    bookingDate: new Date(successor.startsAt.getTime() + 12 * 60 * 60 * 1000),
    documentNumber: `SYS-EB-${successor.year}-${fiscalYearId.slice(-6)}-G${closeGeneration.generation}`,
    description: `Saldenvortrag aus ${predecessorYear}, Abschlussgeneration ${closeGeneration.generation}`,
    source: 'OPENING', externalKey: `${openingKey}:${closeGeneration.id}`,
    lines: { create: lines },
  } })
}
