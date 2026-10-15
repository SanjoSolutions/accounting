import 'server-only'

import type { Prisma } from '@/generated/prisma/client'
import { canonicalJson } from '@/core/compliance/auditExport'
import { createEBalancePackage } from '@/core/eBilanzPackage'
import { prisma } from '@/server/persistence/client'
import { assertCurrentEBalanceExport, prepareAuthoritativeEBalanceExport } from '@/server/compliance/eBilanzExportRepository'
import type { ExternalEBalanceSource } from './adapter'
import { ExternalExportError } from './repository'

async function requireExistingGeneration(client: Prisma.TransactionClient, ownerId: string, fiscalYearId: string) {
  // Close generations are retained immutable records. Do not let a read-only
  // overview/download invoke the legacy provider's lazy generation remediation.
  const generation = await client.fiscalCloseGeneration.findFirst({ where: { ownerId, fiscalYearId }, select: { id: true } })
  if (!generation) throw new ExternalExportError('Bitte den Abschluss prüfen und mit einer aktuellen Abschlussgeneration sperren.')
}

export async function prepareExternalSource(ownerId: string, fiscalYearId: string) {
  try {
    await requireExistingGeneration(prisma, ownerId, fiscalYearId)
    const prepared = await prepareAuthoritativeEBalanceExport(ownerId, fiscalYearId)
    const { dataset } = prepared
    if (prepared.diagnostics.level !== 'LOCAL_STRUCTURAL' || !prepared.diagnostics.valid) throw new Error('Die lokale Strukturprüfung der Exportgrundlage ist fehlgeschlagen.')
    return {
      fiscalYearId: dataset.fiscalYear.id, year: dataset.fiscalYear.year,
      startsAt: dataset.fiscalYear.startsAt, endsAt: dataset.fiscalYear.endsAt,
      closeGenerationId: dataset.closeGenerationId, sourceFingerprint: prepared.datasetChecksum,
      taxonomyVersion: dataset.taxonomy.version, accounts: dataset.accounts,
      dataset, xbrl: prepared.xml,
      xbrlPackage: createEBalancePackage(prepared.xml, dataset.fiscalYear.year, prepared.officialArchive, {
        'export-data.json': canonicalJson(dataset), 'local-validation.json': canonicalJson(prepared.diagnostics),
      }),
      evidenceChecksum: prepared.evidenceChecksum,
    } satisfies ExternalEBalanceSource & { evidenceChecksum: string }
  } catch (error) {
    throw new ExternalExportError(error instanceof Error ? error.message : 'Die Exportgrundlage ist nicht bereit.')
  }
}

export async function assertCurrentExternalSource(ownerId: string, source: Awaited<ReturnType<typeof prepareExternalSource>>, client: Prisma.TransactionClient) {
  try {
    await requireExistingGeneration(client, ownerId, source.fiscalYearId)
    await assertCurrentEBalanceExport(client, ownerId, source)
  } catch (error) {
    throw new ExternalExportError(error instanceof Error ? error.message : 'Die Exportgrundlage hat sich geändert.')
  }
}
