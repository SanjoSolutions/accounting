import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { SearchTextError, type SearchTextExtractor } from './documentSearchText'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-document-search-'))
const databasePath = join(directory, 'test.db').replaceAll('\\', '/')
const storageRoot = join(directory, 'storage')
let api: typeof import('./documentSearch')
let prisma: typeof import('./persistence/client').prisma
const ready = (text: string) => ({ text, status: 'READY' as const, source: 'PDF_TEXT', failureCode: null })

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve('prisma/migrations')
  for (const name of readdirSync(migrations).sort()) if (name !== 'migration_lock.toml') database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`)
  vi.stubEnv('DOCUMENT_STORAGE_DRIVER', 'fs')
  vi.stubEnv('DOCUMENT_STORAGE_ROOT', storageRoot)
  api = await import('./documentSearch')
  prisma = (await import('./persistence/client')).prisma
})

afterAll(async () => {
  await prisma?.$disconnect()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

async function document(id: string, name = `${id}.pdf`, ownerId = 'tenant-a', availableForBooking = true) {
  const storageKey = `documents/${ownerId}/${id}.pdf`
  const content = readFileSync('e2e/fixtures/invoice.pdf')
  mkdirSync(join(storageRoot, 'documents', ownerId), { recursive: true })
  writeFileSync(join(storageRoot, storageKey), content)
  await prisma.documentRecord.create({ data: { id, ownerId, availableForBooking, payload: JSON.stringify({ id, ownerId, storageKey, fileName: name, contentType: 'application/pdf' }) } })
}

describe('tenant-isolated durable document search', () => {
  test('Given old unindexed uploads, when searching, then normalized filename matches already work without writes', async () => {
    await document('old-name', 'Büro Straße.pdf')
    const result = await api.searchDocuments('tenant-a', 'BURO STRASSE')
    expect(result.documents).toMatchObject([{ id: 'old-name', search: { status: 'PENDING' } }])
    expect(await prisma.documentSearchIndex.count()).toBe(0)
    expect(result.retryDocumentIds).toContain('old-name')
  })
  test('Given PDF bytes and another tenant, when indexing and searching, then content persists and no foreign names, snippets or identifiers leak', async () => {
    await document('real-text', 'upload.pdf')
    await document('foreign', 'foreign E2E-2026-001.pdf', 'tenant-b')
    expect(await (await import('./index')).readDocumentFile('real-text', 'tenant-a')).toMatchObject({ contentType: 'application/pdf' })
    await expect(api.indexDocumentSearch('tenant-a', 'real-text')).resolves.toMatchObject({ status: 'READY' })
    await expect(api.indexDocumentSearch('tenant-a', 'foreign')).rejects.toMatchObject({ status: 404 })
    const result = await api.searchDocuments('tenant-a', 'e2e-2026-001')
    expect(result.documents.map(item => item.id)).toEqual(['real-text'])
    expect(result.documents[0].snippet).toContain('e2e-2026-001')
    expect(JSON.stringify(result)).not.toMatch(/storageKey|inputHash|tenant-b|foreign/)
    const reopened = new DatabaseSync(databasePath)
    expect(reopened.prepare('SELECT text, inputHash FROM DocumentSearchIndex WHERE documentId = ?').get('real-text')).toMatchObject({ text: expect.stringContaining('e2e-2026-001'), inputHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    reopened.close()
  }, 30_000)
  test('Given filename and content matches, when searching, then filename matches rank first and whitespace returns a stable paginated list', async () => {
    await document('rank-content', 'plain.pdf')
    await document('rank-name', 'Needle.pdf')
    await api.indexDocumentSearch('tenant-a', 'rank-content', async () => ready('Needle in content'))
    expect((await api.searchDocuments('tenant-a', 'needle')).documents.map(item => item.id)).toEqual(['rank-name', 'rank-content'])
    expect((await api.searchDocuments('tenant-a', 'nothing-matches')).documents).toEqual([])
    await expect(api.searchDocuments('tenant-a', '', -1)).rejects.toThrow(RangeError)
    for (let n = 0; n < 52; n++) await document(`pagination-${String(n).padStart(2, '0')}`)
    const first = await api.searchDocuments('tenant-a', 'pagination')
    const second = await api.searchDocuments('tenant-a', 'pagination', 50)
    expect(first.total).toBe(52)
    expect(first.documents).toHaveLength(50)
    expect(second.documents).toHaveLength(2)
    expect(new Set([...first.documents, ...second.documents].map(item => item.id)).size).toBe(52)
  })
  test('Given booked documents, when the picker searches, then availability stays unchanged and explicit archive scope can include them', async () => {
    await document('booked', 'ArchivedInvoice.pdf', 'tenant-a', false)
    expect((await api.searchDocuments('tenant-a', 'ArchivedInvoice')).documents).toEqual([])
    expect((await api.searchDocuments('tenant-a', 'ArchivedInvoice', 0, 'all')).documents).toMatchObject([{ id: 'booked' }])
  })
  test('Given parser failure, missing OCR and a later successful retry, when indexing, then states are durable and complete results are reused', async () => {
    await document('retry')
    expect(await api.indexDocumentSearch('tenant-a', 'retry', async () => { throw new SearchTextError('TIMEOUT') })).toMatchObject({ status: 'FAILED', failureCode: 'TIMEOUT' })
    expect(await api.indexDocumentSearch('tenant-a', 'retry', async () => ({ text: '', status: 'NEEDS_OCR', source: null, failureCode: 'OCR_NOT_CONFIGURED' }))).toMatchObject({ status: 'NEEDS_OCR' })
    expect(await api.indexDocumentSearch('tenant-a', 'retry', async () => ({ ...ready('scanned recovered'), source: 'OCR' }))).toMatchObject({ status: 'READY', source: 'OCR' })
    const unnecessary = vi.fn<SearchTextExtractor>()
    await api.indexDocumentSearch('tenant-a', 'retry', unnecessary)
    expect(unnecessary).not.toHaveBeenCalled()
    expect((await api.searchDocuments('tenant-a', 'scanned recovered')).documents).toMatchObject([{ id: 'retry' }])
  })
  test('Given a live attempt followed by expired-lease recovery, when the stale worker finishes, then it cannot overwrite the recovered result', async () => {
    await document('lease')
    let finish!: (value: ReturnType<typeof ready>) => void
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const first = api.indexDocumentSearch('tenant-a', 'lease', () => { started(); return new Promise(resolve => { finish = resolve }) })
    await running
    const duplicate = vi.fn<SearchTextExtractor>()
    expect(await api.indexDocumentSearch('tenant-a', 'lease', duplicate)).toMatchObject({ status: 'PROCESSING' })
    expect(duplicate).not.toHaveBeenCalled()
    await prisma.documentSearchIndex.update({ where: { documentId: 'lease' }, data: { leaseUntil: new Date(0) } })
    expect((await api.searchDocuments('tenant-a', 'lease')).documents[0].search).toMatchObject({ status: 'FAILED', failureCode: 'INTERRUPTED' })
    await api.indexDocumentSearch('tenant-a', 'lease', async () => ready('recovered result'))
    finish(ready('stale result')); await first
    expect(await prisma.documentSearchIndex.findUnique({ where: { documentId: 'lease' } })).toMatchObject({ status: 'READY', text: 'recovered result' })
  })
  test('Given a composite owner boundary, when a mismatched index is inserted directly, then the database rejects it', async () => {
    await expect(prisma.documentSearchIndex.create({ data: { documentId: 'foreign', ownerId: 'tenant-a', status: 'READY', text: 'leak' } })).rejects.toThrow()
  })
  test('Given more incomplete files than a batch, when the first files fail, then unattempted files get the next batch', async () => {
    for (let n = 0; n < 21; n++) {
      const id = `batch-${n}`
      await document(id, `${id}.pdf`, 'batch-tenant')
    }
    const first = await api.searchDocuments('batch-tenant')
    expect(first.retryDocumentIds).toHaveLength(20)
    for (const documentId of first.retryDocumentIds) await prisma.documentSearchIndex.create({ data: { documentId, ownerId: 'batch-tenant', status: 'FAILED', failureCode: 'OCR_FAILURE' } })
    const next = await api.searchDocuments('batch-tenant')
    expect(first.retryDocumentIds).not.toContain(next.retryDocumentIds[0])
    expect(next.pending).toBe(21)
  })
})
