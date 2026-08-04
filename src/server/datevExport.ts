import 'server-only'

import { createHash } from 'node:crypto'
import { AccountingValidationError, type AccountCategory } from '@/core/doubleEntry'
import { createDatevBookingBatch, type DatevExportEntry } from '@/core/datevExport'
import { prisma } from './persistence/client'
import { getDocumentStorage } from './storage'
import { registerRetainedArtifact } from './compliance/runtime'

export type DatevExportArtifact = { bytes: Buffer; fileName: string; contentHash: string; storageKey: string; retainedArtifactId: string }

export async function exportDatevBookingBatch(ownerId: string, actorId: string, year: number, now = new Date()): Promise<DatevExportArtifact> {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new AccountingValidationError(['A valid fiscal year is required.'])
  const [period, profile] = await Promise.all([
    prisma.fiscalYear.findFirst({ where: { ownerId, year }, include: { journalEntries: { orderBy: { sequenceNumber: 'asc' }, include: { lines: { include: { account: true } } } } } }),
    prisma.ledgerProfile.findUnique({ where: { ownerId } }),
  ])
  if (!period) throw new AccountingValidationError([`Fiscal year ${year} does not exist.`])
  if (!profile?.consultantNumber || !profile.clientNumber || !profile.accountLength || !['SKR03', 'SKR04'].includes(profile.chart)) throw new AccountingValidationError(['Configure the DATEV consultant number, client number, account length, and SKR03/SKR04 chart by importing verified DATEV master data first.'])
  if (period.journalEntries.length > 99_999) throw new AccountingValidationError(['A DATEV booking batch may contain at most 99,999 postings.'])
  const entries: DatevExportEntry[] = period.journalEntries.map(entry => ({
    id: entry.id, bookingDate: entry.bookingDate.toISOString().slice(0, 10), documentNumber: entry.documentNumber, description: entry.description,
    lines: entry.lines.map(line => ({ accountNumber: line.account.number, category: line.account.category as AccountCategory, debitCents: line.debitCents, creditCents: line.creditCents })),
  }))
  const datasetHash = createHash('sha256').update(JSON.stringify({ ownerId, year, period: [period.startsAt, period.endsAt], profile, entries })).digest('hex')
  const objectId = `DATEV_BOOKING_BATCH:${year}:${datasetHash}`
  const existing = await prisma.retainedArtifact.findFirst({ where: { ownerId, objectType: 'DatevBookingBatch', objectId }, orderBy: { version: 'desc' } })
  const fileName = `EXTF_Buchungsstapel_${year}.csv`
  if (existing?.storageKey && await getDocumentStorage().exists(existing.storageKey)) return { bytes: await getDocumentStorage().read(existing.storageKey), fileName, contentHash: existing.contentHash, storageKey: existing.storageKey, retainedArtifactId: existing.id }

  const bytes = Buffer.from(createDatevBookingBatch({
    consultantNumber: profile.consultantNumber, clientNumber: profile.clientNumber,
    fiscalYearStart: iso(period.startsAt), periodStart: iso(period.startsAt), periodEnd: iso(period.endsAt),
    accountLength: profile.accountLength, chart: profile.chart as 'SKR03' | 'SKR04', generatedAt: datevTimestamp(now),
  }, entries))
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const storageKey = `datev-exports/${encodeURIComponent(ownerId)}/${year}/${datasetHash}.csv`
  const storage = getDocumentStorage()
  const created = await storage.writeIfAbsent(storageKey, bytes, { contentType: 'text/csv; charset=utf-8', fileName })
  try {
    const artifact = await registerRetainedArtifact(ownerId, actorId, { objectType: 'DatevBookingBatch', objectId, retentionClass: 'JOURNAL', periodEndsAt: iso(period.endsAt), provenance: `DATEV EXTF 700 Buchungsstapel format 13; ledger dataset ${datasetHash}; UTF-8 BOM; exact explicit-account cent splits`, storageKey, content: bytes, reason: 'Authenticated DATEV adviser export' })
    return { bytes, fileName, contentHash, storageKey, retainedArtifactId: artifact.id }
  } catch (error) {
    if (created) await storage.delete(storageKey).catch(() => undefined)
    throw error
  }
}

function iso(value: Date) { return value.toISOString().slice(0, 10) }
function datevTimestamp(value: Date) { return value.toISOString().replace(/[-:TZ.]/g, '').slice(0, 17) }
