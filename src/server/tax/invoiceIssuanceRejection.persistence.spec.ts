import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-issuance-rejection-'))
let prisma: typeof import('@/server/persistence/client').prisma
let retire: typeof import('./invoiceIssuanceRejection').retireRejectedInvoiceRequest

beforeAll(async () => {
  const databasePath = join(directory, 'test.db').replaceAll('\\', '/')
  const database = new DatabaseSync(databasePath)
  const migrations = resolve('prisma/migrations')
  try {
    // Only fixture construction skips disk flushes; assertions use a fresh
    // Prisma connection with its normal transaction/durability settings.
    database.exec('PRAGMA synchronous = OFF')
    for (const name of readdirSync(migrations, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  } finally { database.close() }
  process.env.DATABASE_URL = `file:${databasePath}`
  prisma = (await import('@/server/persistence/client')).prisma
  retire = (await import('./invoiceIssuanceRejection')).retireRejectedInvoiceRequest
})
afterAll(async () => { await prisma?.$disconnect(); rmSync(directory, { recursive: true, force: true }) })

describe('authoritative issuance rejection', () => {
  test('Given rejected data before any claim, when revision is permitted, then the old key is durably retired against late requests', async () => {
    const requestKey = 'rejected-before-claim'
    expect(await retire('tenant-a', requestKey)).toBe(true)
    await expect(prisma.invoiceIssuanceRequest.findUnique({ where: { ownerId_requestKey: { ownerId: 'tenant-a', requestKey } } })).resolves.toMatchObject({ status: 'REJECTED', structuredInvoiceId: null })
    await expect(prisma.invoiceIssuanceRequest.create({ data: { ownerId: 'tenant-a', requestKey, requestHash: 'a'.repeat(64) } })).rejects.toThrow()
    expect(await retire('tenant-a', requestKey)).toBe(true)
    expect(await prisma.invoiceIssuanceRequest.count({ where: { ownerId: 'tenant-b' } })).toBe(0)
  })

  test.each(['PROCESSING', 'RECOVERING', 'ISSUED'])(
    'Given an existing %s request, when a failure response is returned, then its key remains recoverable', async status => {
      const requestKey = `existing-request-${status}`
      await prisma.invoiceIssuanceRequest.create({ data: { ownerId: 'tenant-a', requestKey, requestHash: 'b'.repeat(64), status, ...(status === 'ISSUED' ? { structuredInvoiceId: 'saved-invoice' } : {}) } })
      expect(await retire('tenant-a', requestKey)).toBe(false)
      await expect(prisma.invoiceIssuanceRequest.findUnique({ where: { ownerId_requestKey: { ownerId: 'tenant-a', requestKey } } })).resolves.toMatchObject({ status })
    },
  )

  test('Given a failed unissued request, when revision is acknowledged, then automatic reclaim is disabled', async () => {
    const requestKey = 'failed-request-retired'
    await prisma.invoiceIssuanceRequest.create({ data: { ownerId: 'tenant-a', requestKey, requestHash: 'c'.repeat(64), status: 'FAILED' } })
    expect(await retire('tenant-a', requestKey)).toBe(true)
    const reclaimed = await prisma.invoiceIssuanceRequest.updateMany({ where: { ownerId: 'tenant-a', requestKey, status: 'FAILED', structuredInvoiceId: null }, data: { status: 'PROCESSING' } })
    expect(reclaimed.count).toBe(0)
  })

  test('Given a malformed request key, when a request is rejected, then no invalid recovery record is stored', async () => {
    const count = await prisma.invoiceIssuanceRequest.count()
    expect(await retire('tenant-a', undefined)).toBe(false)
    expect(await retire('tenant-a', 'bad')).toBe(false)
    expect(await prisma.invoiceIssuanceRequest.count()).toBe(count)
  })
})
