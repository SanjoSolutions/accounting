import { prisma } from '@/server/persistence/client'
import { ensureLedger, normalizeDocumentIds } from '@/server/ledger'
import { AccountingValidationError } from '@/core/doubleEntry'
import {
  ComplianceRuntimeError,
  createDraft,
  postDraft,
  reviseDraft,
} from '@/server/compliance/runtime'

const DEFAULT_DRAFT_REASON = 'Manual booking batch created'
const DEFAULT_REVISION_REASON = 'Manual booking batch revised after review'
const DEFAULT_POST_REASON = 'Manual booking batch approved for posting'

export type BookingBatchDocument = {
  id: string
  url?: string
  fileName?: string
  contentType?: string
  size?: number
}

function requireYear(value: unknown) {
  const year = typeof value === 'number' ? value : typeof value === 'string' && /^\d{4}$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new ComplianceRuntimeError('year must be an integer from 1900 through 2200', 400)
  return year
}

function objectBody(input: unknown, message: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ComplianceRuntimeError(message, 400)
  return input as Record<string, unknown>
}

function postingBody(body: Record<string, unknown>) {
  for (const key of ['posting', 'draft', 'data'] as const) {
    const candidate = body[key]
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      const nested = candidate as Record<string, unknown>
      if (nested.posting && typeof nested.posting === 'object' && !Array.isArray(nested.posting)) return nested.posting as Record<string, unknown>
      return nested
    }
  }
  const { expectedVersion: _expectedVersion, reason: _reason, draftId: _draftId, ...posting } = body
  return posting
}

function parseDraftPayload(payload: string, draftId: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(payload)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw new ComplianceRuntimeError(`Draft ${draftId} has a corrupted payload`, 409)
  }
}

export function publicBookingBatchDraft<T extends {
  id: string
  payload: string
  createdAt: Date
  updatedAt: Date
}>(draft: T) {
  const { payload, createdAt, updatedAt, ...metadata } = draft
  return {
    ...metadata,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    posting: parseDraftPayload(payload, draft.id),
  }
}

function safeDocumentMetadata(record: { id: string; payload: string }): BookingBatchDocument {
  let payload: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(record.payload)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
  } catch {
    // A document payload may be legacy data. The id remains safe metadata.
  }
  const result: BookingBatchDocument = { id: record.id }
  for (const [target, source] of [['url', 'url'], ['fileName', 'fileName'], ['contentType', 'contentType']] as const) {
    if (typeof payload[source] === 'string' && payload[source].trim()) result[target] = payload[source] as string
  }
  if (typeof payload.size === 'number' && Number.isSafeInteger(payload.size) && payload.size >= 0) result.size = payload.size
  return result
}

function postingDocumentIds(posting: Record<string, unknown>) {
  return normalizeDocumentIds(posting)
}

async function validatePostingReferences(ownerId: string, posting: Record<string, unknown>) {
  const documentIds = postingDocumentIds(posting)
  if (documentIds.length) {
    const ownedDocuments = await prisma.documentRecord.count({ where: { ownerId, id: { in: documentIds } } })
    if (ownedDocuments !== documentIds.length) throw new AccountingValidationError(['Mindestens ein ausgewählter Beleg ist ungültig oder gehört zu einem anderen Mandanten.'])
  }
  const accountIds = Array.isArray(posting.lines)
    ? posting.lines.flatMap(line => line && typeof line === 'object' && typeof (line as { accountId?: unknown }).accountId === 'string' ? [(line as { accountId: string }).accountId] : [])
    : []
  if (accountIds.length) {
    const ownedAccounts = await prisma.ledgerAccount.count({ where: { ownerId, active: true, id: { in: [...new Set(accountIds)] } } })
    if (ownedAccounts !== new Set(accountIds).size) throw new AccountingValidationError(['Mindestens ein Konto ist ungültig oder gehört zu einem anderen Mandanten.'])
  }
}

async function documentMetadataForDrafts(ownerId: string, drafts: Array<{ id: string; posting: Record<string, unknown> }>) {
  const documentIds = [...new Set(drafts.flatMap(draft => postingDocumentIds(draft.posting)))]
  if (!documentIds.length) return new Map<string, BookingBatchDocument>()
  const records = await prisma.documentRecord.findMany({
    where: { ownerId, id: { in: documentIds } },
    select: { id: true, payload: true },
  })
  return new Map(records.map(record => [record.id, safeDocumentMetadata(record)]))
}

/**
 * Lists editable batches and the active account choices for one tenant/year.
 * Posted journal entries deliberately do not appear here; callers continue to
 * use GET /api/booking-records for the immutable journal/dashboard view.
 */
export async function getBookingBatches(ownerId: string, requestedYear: unknown) {
  const year = requireYear(requestedYear)
  const fiscalYear = await ensureLedger(ownerId, year)
  const [accounts, rows] = await Promise.all([
    prisma.ledgerAccount.findMany({ where: { ownerId, active: true }, orderBy: { number: 'asc' } }),
    prisma.journalDraft.findMany({ where: { ownerId, fiscalYearId: fiscalYear.id, status: 'DRAFT' }, orderBy: { updatedAt: 'desc' } }),
  ])
  const drafts = rows.map(row => ({ row, posting: parseDraftPayload(row.payload, row.id) }))
  const metadata = await documentMetadataForDrafts(ownerId, drafts.map(draft => ({ id: draft.row.id, posting: draft.posting })))
  return {
    fiscalYear: {
      id: fiscalYear.id,
      year: fiscalYear.year,
      label: fiscalYear.label ?? String(fiscalYear.year),
      startsAt: fiscalYear.startsAt.toISOString().slice(0, 10),
      endsAt: fiscalYear.endsAt.toISOString().slice(0, 10),
      status: fiscalYear.status,
    },
    accounts: accounts.map(account => ({ id: account.id, number: account.number, name: account.name, category: account.category, active: account.active })),
    drafts: drafts.map(({ row, posting }) => {
      const documentIds = postingDocumentIds(posting)
      return {
        id: row.id,
        fiscalYearId: row.fiscalYearId,
        version: row.version,
        status: row.status,
        createdBy: row.createdBy,
        updatedBy: row.updatedBy,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        posting,
        documentIds,
        documents: documentIds.flatMap(id => { const document = metadata.get(id); return document ? [document] : [] }),
      }
    }),
  }
}

/** Creates a manual booking batch and derives its fiscal period from the posting year/date. */
export async function createBookingBatch(ownerId: string, actorId: string, input: unknown) {
  const body = objectBody(input, 'Booking batch payload must be an object')
  const bookingDate = typeof body.bookingDate === 'string' ? body.bookingDate : undefined
  const explicitYear = typeof body.fiscalYear === 'number' || (typeof body.fiscalYear === 'string' && /^\d{4}$/.test(body.fiscalYear)) ? Number(body.fiscalYear) : Number.NaN
  const year = Number.isInteger(explicitYear) ? explicitYear : bookingDate && /^\d{4}-\d{2}-\d{2}$/.test(bookingDate) ? Number(bookingDate.slice(0, 4)) : Number.NaN
  const fiscalYear = await ensureLedger(ownerId, requireYear(year))
  const posting = postingBody(body)
  await validatePostingReferences(ownerId, posting)
  const reason = body.reason === undefined ? DEFAULT_DRAFT_REASON : body.reason
  return createDraft(ownerId, actorId, { fiscalPeriodId: fiscalYear.id, posting, reason })
}

export async function reviseBookingBatch(ownerId: string, actorId: string, draftId: string, input: unknown) {
  const body = objectBody(input, 'Booking batch revision must be an object')
  const posting = postingBody(body)
  await validatePostingReferences(ownerId, posting)
  const reason = body.reason === undefined ? DEFAULT_REVISION_REASON : body.reason
  return reviseDraft(ownerId, actorId, draftId, { ...body, posting, reason })
}

export async function postBookingBatch(ownerId: string, actorId: string, draftId: string, input?: unknown) {
  let reason: unknown = DEFAULT_POST_REASON
  if (input !== undefined) {
    const body = objectBody(input, 'Booking batch post payload must be an object')
    if (body.reason !== undefined) reason = body.reason
  }
  return postDraft(ownerId, actorId, draftId, reason)
}

export function bookingBatchError(error: unknown) {
  if (error instanceof ComplianceRuntimeError) return Response.json({ success: false, error: error.message }, { status: error.status })
  if (error instanceof AccountingValidationError) return Response.json({ success: false, issues: error.issues }, { status: 400 })
  if (error instanceof SyntaxError) return Response.json({ success: false, error: 'Invalid JSON payload' }, { status: 400 })
  if ((error as { code?: string } | null)?.code === 'P2002') return Response.json({ success: false, error: 'The booking batch changed concurrently.' }, { status: 409 })
  return Response.json({ success: false, error: 'The booking batch could not be processed.' }, { status: 500 })
}
