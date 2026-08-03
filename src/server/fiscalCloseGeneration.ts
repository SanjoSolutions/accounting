import 'server-only'

import { randomUUID } from 'node:crypto'
import type { Prisma } from '@/generated/prisma/client'
import { AccountingValidationError } from '@/core/doubleEntry'
import { sha256 } from './compliance/retention'
import { prisma } from './persistence/client'

type CloseClient = Prisma.TransactionClient | typeof prisma

type ClosedFiscalYear = {
  id: string
  year: number
  status: string
  lockedAt: Date | null
  closingSnapshot: string | null
}

type LockedHgbCloseRun = {
  id: string
  ownerId: string
  fiscalPeriodId: string
  status: string
  checksum: string
}

export async function createFiscalCloseGeneration(
  transaction: Prisma.TransactionClient,
  ownerId: string,
  fiscalYearId: string,
  hgbCloseRun: LockedHgbCloseRun,
  closingSnapshot: string,
  lockedAt: Date,
) {
  if (hgbCloseRun.ownerId !== ownerId || hgbCloseRun.fiscalPeriodId !== fiscalYearId || hgbCloseRun.status !== 'READY_TO_LOCK') {
    throw new AccountingValidationError(['The HGB close run cannot be bound to this tenant fiscal close.'])
  }
  const latest = await transaction.fiscalCloseGeneration.findFirst({
    where: { ownerId, fiscalYearId },
    orderBy: { generation: 'desc' },
    select: { generation: true },
  })
  return transaction.fiscalCloseGeneration.create({ data: {
    id: randomUUID(), ownerId, fiscalYearId, generation: (latest?.generation ?? 0) + 1,
    hgbCloseRunId: hgbCloseRun.id, hgbCloseRunChecksum: hgbCloseRun.checksum,
    snapshotHash: sha256(closingSnapshot), lockedAt,
  } })
}

export async function requireCurrentFiscalCloseGeneration(
  client: CloseClient,
  ownerId: string,
  fiscalYear: ClosedFiscalYear,
) {
  if (fiscalYear.status !== 'CLOSED' || !fiscalYear.lockedAt || !fiscalYear.closingSnapshot) {
    throw new AccountingValidationError(['A currently locked fiscal close generation is required for E-Bilanz reporting.'])
  }
  // A generation is a binding, not a substitute for checking its sources. Reuse
  // the close-time gate so a later profile, mapping, workpaper, evidence, or
  // ledger revision makes every downstream report fail closed.
  const { requireCurrentReadyHgbClose } = await import('./hgbCloseRepository')
  const currentHgbCloseRun = await requireCurrentReadyHgbClose(client as Prisma.TransactionClient, ownerId, { id: fiscalYear.id, year: fiscalYear.year })
  let generation = await client.fiscalCloseGeneration.findFirst({
    where: { ownerId, fiscalYearId: fiscalYear.id },
    orderBy: { generation: 'desc' },
    include: { hgbCloseRun: true },
  })
  // Safe lazy remediation for fiscal years closed before close generations were
  // introduced. It is intentionally allowed only after the complete
  // authoritative HGB gate above succeeds against the current sources.
  if (!generation) {
    try {
      await createFiscalCloseGeneration(client as Prisma.TransactionClient, ownerId, fiscalYear.id, currentHgbCloseRun, fiscalYear.closingSnapshot, fiscalYear.lockedAt)
    } catch (error) {
      const raced = await client.fiscalCloseGeneration.findFirst({ where: { ownerId, fiscalYearId: fiscalYear.id }, orderBy: { generation: 'desc' }, include: { hgbCloseRun: true } })
      if (!raced) throw error
    }
    generation = await client.fiscalCloseGeneration.findFirst({ where: { ownerId, fiscalYearId: fiscalYear.id }, orderBy: { generation: 'desc' }, include: { hgbCloseRun: true } })
  }
  if (!generation
    || generation.lockedAt.getTime() !== fiscalYear.lockedAt.getTime()
    || generation.snapshotHash !== sha256(fiscalYear.closingSnapshot)
    || generation.hgbCloseRun.ownerId !== ownerId
    || generation.hgbCloseRun.fiscalPeriodId !== fiscalYear.id
    || generation.hgbCloseRun.status !== 'READY_TO_LOCK'
    || generation.hgbCloseRun.checksum !== generation.hgbCloseRunChecksum
    || currentHgbCloseRun.id !== generation.hgbCloseRunId
    || currentHgbCloseRun.checksum !== generation.hgbCloseRunChecksum) {
    throw new AccountingValidationError(['The fiscal close generation is missing, stale, or does not match the exact locked HGB close.'])
  }
  return generation
}
