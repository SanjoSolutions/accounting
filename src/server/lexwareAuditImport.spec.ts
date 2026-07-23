import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const state = vi.hoisted(() => ({
  existing: [] as any[],
  entries: [] as any[],
  accounts: new Map<number, { id: string; category: string }>(),
  documents: [] as any[],
  claims: [] as Array<{
    id: string
    importId: string
    documentId: string
    ownerId: string
    storageKey: string
    createdStorage: boolean
    createdAt: Date
  }>,
  committedDocuments: new Set<string>(),
  stored: new Set<string>(),
  yearOpen: true,
  mismatchedFiscalYear: false,
  extraFiscalYear: null as null | { year: number; startsAt: Date; endsAt: Date },
  failTransaction: false,
  failJournalCreate: false,
  transactionOptions: [] as any[],
  storageEvents: [] as string[],
  transactionTail: Promise.resolve() as Promise<void>,
  retainedArtifact: null as any,
}))
const parsed = vi.hoisted(() => ({
  chart: 'SKR03' as const,
  accountLength: 4,
  years: [2024, 2025],
  fiscalYears: [
    { year: 2024, startsAt: '2023-10-01', endsAt: '2024-09-30' },
    { year: 2025, startsAt: '2024-10-01', endsAt: '2025-09-30' },
  ],
  accounts: [
    { number: 1200, name: 'Bank', category: 'ASSET' as const },
    { number: 4930, name: 'Expense', category: 'EXPENSE' as const },
  ],
  bookings: [
    { year: 2024, bookingNumber: 7, bookingDate: '2024-09-30', documentNumber: '7', description: 'Old', documentName: null, lines: [
      { accountNumber: 1200, debitCents: 100, creditCents: 0 }, { accountNumber: 4930, debitCents: 0, creditCents: 100 },
    ] },
    { year: 2025, bookingNumber: 1, bookingDate: '2025-01-01', documentNumber: '1', description: 'New', documentName: 'invoice.pdf', lines: [
      { accountNumber: 4930, debitCents: 119, creditCents: 0 }, { accountNumber: 1200, debitCents: 0, creditCents: 119 },
    ] },
  ],
  documents: new Map([['invoice.pdf', { name: 'Invoice.PDF', bytes: new TextEncoder().encode('%PDF-test'), contentType: 'application/pdf' }]]),
}))
const transaction = vi.hoisted(() => ({
  fiscalYear: {
    upsert: vi.fn(async ({ create }: any) => ({
      id: `year-${create.year}`, status: 'OPEN', ...create,
      ...(state.mismatchedFiscalYear && create.year === 2025 ? {
        startsAt: new Date('2025-01-01T00:00:00.000Z'), endsAt: new Date('2025-12-31T23:59:59.999Z'),
      } : {}),
    })),
    updateMany: vi.fn(async () => ({ count: 1 })),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => ({ id: where.id, status: state.yearOpen ? 'OPEN' : 'CLOSED' })),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => {
      const rows = parsed.fiscalYears.map(fiscalYear => ({
        year: fiscalYear.year,
        startsAt: new Date(`${fiscalYear.startsAt}T00:00:00.000Z`),
        endsAt: new Date(`${fiscalYear.endsAt}T23:59:59.999Z`),
      }))
      if (state.mismatchedFiscalYear) rows[1] = {
        year: 2025, startsAt: new Date('2025-01-01T00:00:00.000Z'), endsAt: new Date('2025-12-31T23:59:59.999Z'),
      }
      return [...rows, ...(state.extraFiscalYear ? [state.extraFiscalYear] : [])].sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime())
    }),
  },
  ledgerProfile: {
    upsert: vi.fn(async ({ create }: any) => create),
    update: vi.fn(async () => ({})),
  },
  journalEntry: {
    findMany: vi.fn(async () => state.existing),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async ({ data }: any) => {
      if (state.failJournalCreate) throw new Error('journal create failed')
      state.entries.push(data); return data
    }),
  },
  ledgerAccount: {
    upsert: vi.fn(async ({ create }: any) => {
      if (!state.accounts.has(create.number)) state.accounts.set(create.number, { id: `account-${create.number}`, category: create.category })
      return create
    }),
    findMany: vi.fn(async () => [...state.accounts].map(([number, value]) => ({ number, ...value }))),
  },
  documentRecord: {
    upsert: vi.fn(async (input: any) => { state.documents.push(input); return input.create }),
    findUnique: vi.fn(async ({ where }: any) => state.committedDocuments.has(where.id) ? { id: where.id } : null),
    findMany: vi.fn(async ({ where }: any) => [...state.committedDocuments].filter(id => where.id.in.includes(id)).map(id => ({ id }))),
  },
  retainedArtifact: {
    findUnique: vi.fn(async () => state.retainedArtifact),
    upsert: vi.fn(async ({ create, update }: any) => { state.retainedArtifact = state.retainedArtifact ? { ...state.retainedArtifact, ...update } : create; return state.retainedArtifact }),
  },
  documentStorageClaim: {
    findMany: vi.fn(async ({ where }: any) => state.claims.filter(claim =>
      where.importId ? claim.importId === where.importId : where.documentId.in.includes(claim.documentId),
    )),
    deleteMany: vi.fn(async ({ where }: any) => {
      const before = state.claims.length
      state.claims = state.claims.filter(claim => claim.importId !== where.importId)
      return { count: before - state.claims.length }
    }),
    findFirst: vi.fn(async ({ where }: any) => state.claims.find(claim => claim.documentId === where.documentId) ?? null),
    update: vi.fn(async ({ where, data }: any) => {
      const claim = state.claims.find(item => where.id ? item.id === where.id :
        item.importId === where.importId_documentId.importId && item.documentId === where.importId_documentId.documentId)
      if (!claim) throw new Error('claim missing')
      Object.assign(claim, data)
      return claim
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const claims = state.claims.filter(claim => where.documentId.in.includes(claim.documentId))
      claims.forEach(claim => Object.assign(claim, data))
      return { count: claims.length }
    }),
  },
}))
const storage = vi.hoisted(() => ({
  exists: vi.fn(async (key: string) => state.stored.has(key)),
  write: vi.fn(async (key: string) => { state.stored.add(key) }),
  writeIfAbsent: vi.fn(async (key: string, _content?: Buffer, _metadata?: { contentType: string; fileName: string }) => {
    state.storageEvents.push('storage-write')
    if (state.stored.has(key)) return false
    state.stored.add(key)
    return true
  }),
  delete: vi.fn(async (key: string) => { state.stored.delete(key) }),
}))

vi.mock('server-only', () => ({}))
vi.mock('./compliance/auditPersistence', () => ({ appendAuditEvent: vi.fn() }))
vi.mock('@/core/lexwareAudit', () => ({ parseLexwareAuditFiles: () => parsed }))
vi.mock('./storage', () => ({ getDocumentStorage: () => storage }))
vi.mock('./persistence/client', () => ({
  prisma: {
    documentStorageClaim: {
      createMany: async ({ data }: any) => {
        state.claims.push(...data.map((claim: any) => ({ ...claim, createdStorage: false, createdAt: new Date() })))
        return { count: data.length }
      },
      findMany: async ({ where }: any) => state.claims.filter(claim => claim.createdAt < where.createdAt.lt),
      update: async ({ where, data }: any) => {
        const claim = state.claims.find(item =>
          item.importId === where.importId_documentId.importId && item.documentId === where.importId_documentId.documentId,
        )
        if (!claim) throw new Error('claim missing')
        if (data.createdStorage) state.storageEvents.push('claim-marked')
        Object.assign(claim, data)
        return claim
      },
      deleteMany: async ({ where }: any) => {
        const before = state.claims.length
        state.claims = state.claims.filter(claim => claim.importId !== where.importId)
        return { count: before - state.claims.length }
      },
    },
    $transaction: async (callback: any, options?: any) => {
      state.transactionOptions.push(options)
      const run = async () => {
        if (state.failTransaction) throw new Error('database failed')
        return callback(transaction)
      }
      const result = state.transactionTail.then(run, run)
      state.transactionTail = result.then(() => undefined, () => undefined)
      return result
    },
  },
}))
import { importLexwareAudit } from './lexwareAuditImport'

describe('Lexware Betriebsprüfung persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.existing = []; state.entries = []; state.accounts.clear(); state.documents = []; state.claims = []; state.committedDocuments.clear(); state.stored.clear()
    state.yearOpen = true; state.mismatchedFiscalYear = false; state.extraFiscalYear = null; state.failTransaction = false; state.failJournalCreate = false; state.transactionOptions = []; state.storageEvents = []; state.transactionTail = Promise.resolve(); state.retainedArtifact = null
    parsed.bookings[1].documentNumber = '1'
    parsed.bookings[0].documentName = null
    parsed.documents.clear()
    parsed.documents.set('invoice.pdf', { name: 'Invoice.PDF', bytes: new TextEncoder().encode('%PDF-test'), contentType: 'application/pdf' })
  })

  it('imports multiple years chronologically with accounts and attached documents', async () => {
    const result = await importLexwareAudit('owner-1', [])
    expect(result).toEqual({ format: 'LEXWARE_BP', imported: 2, skipped: 0, accounts: 2, documents: 1, years: [2024, 2025] })
    expect(state.transactionOptions[0]).toEqual({ maxWait: 60_000, timeout: 15 * 60_000 })
    expect(transaction.fiscalYear.upsert.mock.calls.map(call => call[0].create.year)).toEqual([2024, 2025])
    expect(transaction.fiscalYear.upsert.mock.calls[1][0].create).toMatchObject({
      startsAt: new Date('2024-10-01T00:00:00.000Z'),
      endsAt: new Date('2025-09-30T23:59:59.999Z'),
    })
    expect(state.entries.map(entry => entry.source)).toEqual(['LEXWARE_BP', 'LEXWARE_BP'])
    expect(state.entries[1]).toMatchObject({
      documentNumber: expect.stringMatching(/^LEXWARE-1-[0-9a-f]{10}-2025-1$/),
      documents: { create: [{ documentId: expect.stringMatching(/^lexware-/) }] },
      lines: { create: [
        { accountId: 'account-4930', debitCents: 119, creditCents: 0, taxCode: null },
        { accountId: 'account-1200', debitCents: 0, creditCents: 119, taxCode: null },
      ] },
    })
    expect(storage.writeIfAbsent).toHaveBeenCalledOnce()
    const documentPayload = JSON.parse(state.documents[0].create.payload)
    expect(storage.writeIfAbsent.mock.calls[0][0]).toBe(`documents/owner-1/${documentPayload.id}.pdf`)
    expect(storage.writeIfAbsent.mock.calls[0][2]).toMatchObject({ fileName: `${documentPayload.id}.pdf` })
    expect(state.storageEvents.slice(0, 2)).toEqual(['claim-marked', 'storage-write'])
    expect(state.documents[0].create).toMatchObject({ ownerId: 'owner-1', payload: expect.stringContaining('Invoice.PDF') })
  })

  it('retains a shared document through the latest referenced fiscal period', async () => {
    parsed.bookings[0].documentName = 'invoice.pdf'
    await importLexwareAudit('owner-1', [])
    expect(transaction.retainedArtifact.upsert).toHaveBeenCalledWith(expect.objectContaining({ create: expect.objectContaining({ periodEndsAt: new Date('2025-09-30T23:59:59.999Z'), retainUntil: new Date('2033-12-31T23:59:59.999Z') }) }))
  })

  it('persists and retains unreferenced evidence with a conservative fallback period', async () => {
    parsed.documents.set('readme.pdf', { name: 'README.PDF', bytes: new TextEncoder().encode('%PDF-evidence'), contentType: 'application/pdf' })
    await importLexwareAudit('owner-1', [])
    expect(state.documents).toHaveLength(2)
    const evidenceId = state.documents.find(row => row.create.payload.includes('README.PDF'))!.create.id
    const evidenceRetention = transaction.retainedArtifact.upsert.mock.calls.map(call => call[0]).find(call => call.create.objectId === evidenceId)
    expect(evidenceRetention.create).toMatchObject({ periodEndsAt: new Date(`${new Date().getUTCFullYear() + 1}-12-31T23:59:59.999Z`) })
  })

  it('monotonically extends an existing document retention boundary on a later import', async () => {
    state.retainedArtifact = { periodEndsAt: new Date('2024-09-30T23:59:59.999Z'), retainUntil: new Date('2032-12-31T23:59:59.999Z') }
    await importLexwareAudit('owner-1', [])
    expect(transaction.retainedArtifact.upsert).toHaveBeenCalledWith(expect.objectContaining({ update: { periodEndsAt: new Date('2025-09-30T23:59:59.999Z'), retainUntil: new Date('2033-12-31T23:59:59.999Z') } }))
  })

  it('skips bookings with matching stable Lexware identities', async () => {
    await importLexwareAudit('owner-1', [])
    state.existing = state.entries.map(entry => ({
      externalKey: entry.externalKey,
      bookingDate: entry.bookingDate,
      documentNumber: entry.documentNumber,
      description: entry.description,
      lines: entry.lines.create.map((line: any) => ({ ...line, account: { number: Number(line.accountId.replace('account-', '')) } })),
      documents: entry.documents ? [{ document: { payload: JSON.stringify({
        fileName: 'Invoice.PDF', sourceHash: hashBytes(new TextEncoder().encode('%PDF-test')),
      }) } }] : [],
    }))
    state.entries = []
    expect(await importLexwareAudit('owner-1', [])).toMatchObject({ imported: 0, skipped: 2 })
    expect(state.entries).toHaveLength(0)
  })

  it('detects source document-number changes beyond the persisted label length', async () => {
    const sharedPrefix = 'A'.repeat(45)
    parsed.bookings[1].documentNumber = `${sharedPrefix}ONE`
    await importLexwareAudit('owner-1', [])
    state.existing = state.entries.map(entry => ({
      externalKey: entry.externalKey,
      bookingDate: entry.bookingDate,
      documentNumber: entry.documentNumber,
      description: entry.description,
      lines: entry.lines.create.map((line: any) => ({ ...line, account: { number: Number(line.accountId.replace('account-', '')) } })),
      documents: entry.documents ? [{ document: { payload: JSON.stringify({
        fileName: 'Invoice.PDF', sourceHash: hashBytes(new TextEncoder().encode('%PDF-test')),
      }) } }] : [],
    }))
    parsed.bookings[1].documentNumber = `${sharedPrefix}TWO`

    await expect(importLexwareAudit('owner-1', [])).rejects.toThrow(/abweichende Buchungsdaten/)
  })

  it('cleans staged document bytes when validation fails', async () => {
    state.yearOpen = false
    await expect(importLexwareAudit('owner-1', [])).rejects.toThrow(/gesperrt/)
    expect(state.stored.size).toBe(0)
  })

  it('rejects existing fiscal-year boundaries that differ from the Lexware metadata', async () => {
    state.mismatchedFiscalYear = true
    await expect(importLexwareAudit('owner-1', [])).rejects.toThrow(/andere Zeitgrenzen/)
    expect(state.stored.size).toBe(0)
  })

  it('rejects fiscal-year ranges that overlap another owner year', async () => {
    state.extraFiscalYear = {
      year: 2023,
      startsAt: new Date('2024-06-01T00:00:00.000Z'),
      endsAt: new Date('2024-06-30T23:59:59.999Z'),
    }
    await expect(importLexwareAudit('owner-1', [])).rejects.toThrow(/Geschäftsjahre 2024 und 2023 überschneiden sich/)
    expect(state.stored.size).toBe(0)
  })

  it('recovers stale storage claims after an interrupted import', async () => {
    const staleStorageKey = 'documents/owner-1/stale-document'
    state.claims.push({
      id: 'stale-claim', importId: 'stale-import', documentId: 'stale-document', ownerId: 'owner-1',
      storageKey: staleStorageKey, createdStorage: true, createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    })
    state.stored.add(staleStorageKey)

    await importLexwareAudit('owner-1', [])

    expect(state.claims.some(claim => claim.id === 'stale-claim')).toBe(false)
    expect(state.stored.has(staleStorageKey)).toBe(false)
  })

  it('preserves committed storage while removing its stale claim', async () => {
    const staleStorageKey = 'documents/owner-1/committed-document'
    state.claims.push({
      id: 'stale-claim', importId: 'stale-import', documentId: 'committed-document', ownerId: 'owner-1',
      storageKey: staleStorageKey, createdStorage: true, createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    })
    state.committedDocuments.add('committed-document')
    state.stored.add(staleStorageKey)

    await importLexwareAudit('owner-1', [])

    expect(state.claims.some(claim => claim.id === 'stale-claim')).toBe(false)
    expect(state.stored.has(staleStorageKey)).toBe(true)
  })

  it('cleans failed evidence only when no concurrent import has claimed it', async () => {
    state.failJournalCreate = true
    await expect(importLexwareAudit('owner-1', [])).rejects.toThrow(/journal create failed/)
    expect(storage.delete).toHaveBeenCalledOnce()
    expect(state.stored.size).toBe(0)
    expect(transaction.documentStorageClaim.findFirst).not.toHaveBeenCalled()
    expect(transaction.documentRecord.findUnique).not.toHaveBeenCalled()
    expect(transaction.documentRecord.findMany).toHaveBeenCalledOnce()
    expect(state.transactionOptions.at(-1)).toEqual({ maxWait: 60_000, timeout: 15 * 60_000 })

    vi.clearAllMocks()
    const concurrent = await Promise.allSettled([importLexwareAudit('owner-1', []), importLexwareAudit('owner-1', [])])
    expect(concurrent.every(result => result.status === 'rejected')).toBe(true)
    expect(state.claims).toHaveLength(0)
    expect(storage.delete).toHaveBeenCalledOnce()
    expect(state.stored.size).toBe(0)
  })

  it('rejects changed evidence for an existing booking and does not reuse the old PDF', async () => {
    await importLexwareAudit('owner-1', [])
    const originalStorageKey = storage.writeIfAbsent.mock.calls[0][0]
    state.existing = state.entries.map(entry => ({
      externalKey: entry.externalKey,
      bookingDate: entry.bookingDate,
      documentNumber: entry.documentNumber,
      description: entry.description,
      lines: entry.lines.create.map((line: any) => ({ ...line, account: { number: Number(line.accountId.replace('account-', '')) } })),
      documents: entry.documents ? [{ document: { payload: JSON.stringify({
        fileName: 'Invoice.PDF', sourceHash: hashBytes(new TextEncoder().encode('%PDF-test')),
      }) } }] : [],
    }))
    parsed.documents.set('invoice.pdf', { name: 'Invoice.PDF', bytes: new TextEncoder().encode('%PDF-changed'), contentType: 'application/pdf' })

    await expect(importLexwareAudit('owner-1', [])).rejects.toThrow(/abweichende Buchungsdaten/)
    expect(storage.writeIfAbsent).toHaveBeenCalledTimes(2)
    expect(state.stored.has(originalStorageKey)).toBe(true)
    expect(state.stored.size).toBe(1)
  })

  it('does not delete a pre-existing stored document when an import fails', async () => {
    const contentHash = hashBytes(new TextEncoder().encode('%PDF-test'))
    const expectedKey = `documents/owner-1/lexware-${hashPrefix(`owner-1\0invoice.pdf\0${contentHash}`)}.pdf`
    state.stored.add(expectedKey); state.failJournalCreate = true
    await expect(importLexwareAudit('owner-1', [])).rejects.toThrow()
    expect(storage.delete).not.toHaveBeenCalled()
    expect(state.stored.has(expectedKey)).toBe(true)
  })
})

function hashPrefix(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function hashBytes(value: Uint8Array) {
  return createHash('sha256').update(value).digest('hex')
}
