import 'server-only'
import { createHash } from 'node:crypto'
import type { Prisma } from '@/generated/prisma/client'
import { euerCsv, euerYear, EuerValidationError, parseEuerInput, prepareEuer, type EuerReport } from '@/core/euer'
import { prisma } from '@/server/persistence/client'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'
import { selectProfileVersionForPeriod } from './profileRepository'

const checksum = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export class EuerConflictError extends Error {}

async function context(db: Prisma.TransactionClient, ownerId: string, year: number) {
  const fiscal = await db.fiscalYear.findUnique({ where: { ownerId_year: { ownerId, year } } })
  if (!fiscal || fiscal.startsAt.toISOString().slice(0, 10) !== `${year}-01-01` || fiscal.endsAt.toISOString().slice(0, 10) !== `${year}-12-31`) throw new EuerValidationError(['EÜR requires a configured calendar fiscal year.'])
  const versions = await db.companyProfileVersion.findMany({ where: { ownerId, effectiveFrom: { lte: fiscal.endsAt } } })
  const profile = selectProfileVersionForPeriod(versions, fiscal.startsAt, fiscal.endsAt)
  const report = prepareEuer(year, profile, { entries: [], scopeConfirmed: false })
  return { fiscal, profile, report, profileChecksum: checksum(report) }
}

export async function getEuerWorkspace(ownerId: string, yearValue: number) {
  const year = euerYear(yearValue)
  return prisma.$transaction(async db => {
    const current = await context(db, ownerId, year)
    const revisions = await db.euerRevision.findMany({ where: { ownerId, year }, orderBy: { version: 'desc' } })
    const latest = revisions[0]
    const profileChanged = Boolean(latest && latest.profileChecksum !== current.profileChecksum)
    return {
      version: latest?.version ?? 0, locked: current.fiscal.status !== 'OPEN', profileChanged,
      report: latest ? JSON.parse(latest.payload) as EuerReport : current.report,
      currentVatRegime: current.profile.vatRegime,
      history: revisions.map(row => ({ version: row.version, createdAt: row.createdAt.toISOString(), createdBy: row.createdBy })),
    }
  })
}

export async function saveEuerRevision(ownerId: string, actorId: string, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EuerValidationError(['An EÜR save request is required.'])
  const body = value as { year?: number; baseVersion?: number; requestKey?: string; input?: unknown }
  const year = euerYear(body.year)
  if (!Number.isSafeInteger(body.baseVersion) || body.baseVersion! < 0 || typeof body.requestKey !== 'string' || !/^[\w-]{16,100}$/.test(body.requestKey)) throw new EuerValidationError(['EÜR requires a base version and a unique save request key.'])
  const input = parseEuerInput(body.input)
  const requestHash = checksum({ year, baseVersion: body.baseVersion, input, actorId })
  return prisma.$transaction(async db => {
    // The write lock serializes saves, profile transitions and fiscal-year locking.
    await db.$executeRaw`UPDATE "FiscalYear" SET "status" = "status" WHERE "ownerId" = ${ownerId} AND "year" = ${year}`
    const replay = await db.euerRevision.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey: body.requestKey! } } })
    if (replay) {
      if (replay.requestHash !== requestHash) throw new EuerConflictError('This save request already contains different EÜR facts.')
      return { version: replay.version, report: JSON.parse(replay.payload) as EuerReport }
    }
    const current = await context(db, ownerId, year)
    if (current.fiscal.status !== 'OPEN') throw new EuerConflictError('The fiscal year is locked.')
    const latest = await db.euerRevision.findFirst({ where: { ownerId, year }, orderBy: { version: 'desc' } })
    if ((latest?.version ?? 0) !== body.baseVersion) throw new EuerConflictError('The EÜR changed in another session. Reload before saving.')
    const report = prepareEuer(year, current.profile, input)
    const row = await db.euerRevision.create({ data: { ownerId, year, version: body.baseVersion! + 1, requestKey: body.requestKey!, requestHash, profileChecksum: current.profileChecksum, payload: JSON.stringify(report), createdBy: actorId } })
    await appendAuditEvent(db, { ownerId, actorId, action: 'EUER_WORKPAPER_SAVED', reason: input.scopeConfirmed ? 'EÜR scope and entries reviewed' : 'EÜR draft saved', objectType: 'EuerRevision', objectId: row.id, after: { year, version: row.version, checksum: checksum(report), profileChecksum: row.profileChecksum } })
    return { version: row.version, report }
  })
}

export async function exportEuer(ownerId: string, year: number, version: number) {
  const workspace = await getEuerWorkspace(ownerId, year)
  if (!workspace.version || workspace.version !== version || workspace.profileChanged) throw new EuerConflictError('The saved EÜR or company profile changed. Reload and review before exporting.')
  return euerCsv(workspace.report)
}
