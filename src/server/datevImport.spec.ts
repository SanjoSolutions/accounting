import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  accounts: new Map<number, string>(),
  accountCategories: new Map<number, string>(),
  accountNames: new Map<number, string>(),
  entries: [] as Array<{ data: Record<string, any> }>,
  persisted: new Map<string, any>(),
  existingKeys: [] as string[],
  yearOpen: true,
  chart: null as string | null,
  consultantNumber: null as string | null,
  clientNumber: null as string | null,
  accountLength: null as number | null,
}))
const transaction = vi.hoisted(() => ({
  ledgerProfile: {
    upsert: vi.fn(async ({ create }: any) => {
      if (!state.chart) Object.assign(state, create)
      return { ownerId: create.ownerId, chart: state.chart, consultantNumber: state.consultantNumber, clientNumber: state.clientNumber, accountLength: state.accountLength }
    }),
    update: vi.fn(async ({ data }: any) => { Object.assign(state, data); return { ...data } }),
  },
  journalEntry: {
    findMany: vi.fn(async () => state.existingKeys.flatMap(externalKey => state.persisted.has(externalKey) ? [state.persisted.get(externalKey)] : [])),
    findFirst: vi.fn(async () => null),
    create: vi.fn(async (input: { data: Record<string, any> }) => {
      state.entries.push(input)
      if (input.data.externalKey) state.persisted.set(input.data.externalKey, {
        externalKey: input.data.externalKey, bookingDate: input.data.bookingDate, documentNumber: input.data.documentNumber, description: input.data.description,
        lines: input.data.lines.create.map((line: any) => ({ ...line, account: { number: Number(line.accountId.replace('account-', '')) } })),
      })
      return input.data
    }),
  },
  fiscalYear: {
    upsert: vi.fn(async ({ create }: any) => ({ id: `year-${create.year}`, ...create })),
    updateMany: vi.fn(async () => ({ count: 1 })),
    findFirst: vi.fn(async () => null),
    findUniqueOrThrow: vi.fn(async ({ where }: any) => ({ id: where.id ?? `year-${where.ownerId_year.year}`, status: state.yearOpen ? 'OPEN' : 'CLOSED' })),
  },
  ledgerAccount: {
    upsert: vi.fn(async ({ create, update }: any) => {
      if (!state.accounts.has(create.number)) {
        state.accounts.set(create.number, `account-${create.number}`)
        state.accountCategories.set(create.number, create.category)
        state.accountNames.set(create.number, create.name)
      } else if (update.name) {
        state.accountNames.set(create.number, update.name)
      }
      return create
    }),
    findMany: vi.fn(async () => [...state.accounts].map(([number, id]) => ({ number, id, category: state.accountCategories.get(number) }))),
  },
}))
vi.mock('server-only', () => ({}))
vi.mock('./persistence/client', () => ({ prisma: { $transaction: (callback: any) => callback(transaction) } }))
vi.mock('./ledger', () => ({ DEFAULT_ACCOUNTS: [
  [1200, 'Bank', 'ASSET', 'bs.ass.currAss.cashEquiv.bank'],
  [1600, 'Verbindlichkeiten', 'LIABILITY', 'bs.eqLiab.liab.trade'],
  [8400, 'Erlöse', 'REVENUE', 'is.netIncome'],
] }))
import { createDatevLines, importDatev, validateDatevImportSize } from './datevImport'

describe('DATEV ledger import', () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.accounts.clear(); state.accountCategories.clear(); state.accountNames.clear(); state.entries.length = 0; state.persisted.clear(); state.existingKeys = []; state.yearOpen = true
    state.chart = null; state.consultantNumber = null; state.clientNumber = null; state.accountLength = null
  })

  it('atomically creates tenant accounts and balanced journal entries with correct S/H orientation', async () => {
    const result = await importDatev('owner-1', [bookingFile('H')])
    expect(result).toMatchObject({ imported: 1, skipped: 0, accounts: 2, years: [2025] })
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0].data).toMatchObject({ source: 'DATEV', fiscalYearId: 'year-2025' })
    expect(state.entries[0].data.externalKey).toMatch(/^DATEV:[a-f0-9]{64}$/)
    expect(state.entries[0].data.externalKey).not.toContain('guid-private')
    expect(state.accountNames.get(1200)).toBe('Bank')
    expect(state.entries[0].data.lines.create).toEqual([
      { accountId: 'account-1200', debitCents: 0, creditCents: 1234, taxCode: null },
      { accountId: 'account-8000', debitCents: 1234, creditCents: 0, taxCode: null },
    ])
  })

  it('skips an already imported external booking and refuses a locked year', async () => {
    await importDatev('owner-1', [bookingFile('S')])
    state.existingKeys = [state.entries[0].data.externalKey]
    state.entries.length = 0
    expect(await importDatev('owner-1', [bookingFile('S')])).toMatchObject({ imported: 0, skipped: 1 })
    expect(state.entries).toHaveLength(0)
    expect(transaction.fiscalYear.updateMany.mock.invocationCallOrder[1]).toBeLessThan(transaction.journalEntry.findMany.mock.invocationCallOrder[1])

    state.existingKeys = []; state.yearOpen = false
    await expect(importDatev('owner-1', [bookingFile('S')])).rejects.toThrow(/gesperrt/)
  })

  it('rejects changed content for a previously imported GUID', async () => {
    await importDatev('owner-1', [bookingFile('S')])
    const key = state.entries[0].data.externalKey
    state.existingKeys = [key]
    state.persisted.get(key).description = 'Changed after import'
    await expect(importDatev('owner-1', [bookingFile('S')])).rejects.toThrow(/hat abweichende Buchungsdaten/)
  })

  it('rejects a changed stored document reference for an existing GUID', async () => {
    await importDatev('owner-1', [bookingFile('S')])
    const key = state.entries[0].data.externalKey
    state.existingKeys = [key]
    state.persisted.get(key).documentNumber = 'DATEV-OLD-REFERENCE'
    await expect(importDatev('owner-1', [bookingFile('S')])).rejects.toThrow(/hat abweichende Buchungsdaten/)
  })

  it('locks multi-year imports in chronological order', async () => {
    await importDatev('owner-1', [bookingFile('S', '03', '1200', '8000', 'guid-2026', 2026), bookingFile('S', '03', '1200', '8000', 'guid-2025', 2025)])
    expect(transaction.fiscalYear.upsert.mock.calls.map(call => call[0].create.year)).toEqual([2025, 2026])
  })

  it('rejects conflicting rows that reuse a DATEV booking GUID', async () => {
    await expect(importDatev('owner-1', [
      bookingFile('S', '03', '1200', '8000', 'same-guid'),
      bookingFile('H', '03', '1200', '8000', 'same-guid'),
    ])).rejects.toThrow(/wird für unterschiedliche Buchungen verwendet/)
    expect(state.entries).toHaveLength(0)
  })

  it('does not silently deduplicate legitimate GUID-less bookings across uploads', async () => {
    expect(await importDatev('owner-1', [bookingFile('S', '03', '1200', '8000', '')])).toMatchObject({ imported: 1, skipped: 0 })
    expect(state.entries[0].data.externalKey).toBeNull()
    state.entries.length = 0
    expect(await importDatev('owner-1', [bookingFile('S', '03', '1200', '8000', '')])).toMatchObject({ imported: 1, skipped: 0 })
  })

  it('enriches an existing placeholder with a later DATEV master-data name', async () => {
    await importDatev('owner-1', [bookingFile('S', '03', '10001', '8000', 'first')])
    expect(state.accountNames.get(10001)).toBe('DATEV-Konto 10001')
    await importDatev('owner-1', [masterFile('10001', 'Customer GmbH'), bookingFile('S', '03', '10001', '8000', 'second')])
    expect(state.accountNames.get(10001)).toBe('Customer GmbH')
  })

  it('does not apply SKR03 default categories to an SKR04 import', async () => {
    await importDatev('owner-1', [bookingFile('S', '04', '1600', '4000')])
    expect(transaction.ledgerProfile.upsert).toHaveBeenCalledWith({
      where: { ownerId: 'owner-1' },
      create: { ownerId: 'owner-1', chart: 'SKR04', consultantNumber: '1', clientNumber: '1', accountLength: 4 },
      update: {},
    })
    expect(transaction.ledgerAccount.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ number: 1600, category: 'ASSET', eBilanzPosition: null }),
    }))
  })

  it('rejects an import from a different chart than the tenant ledger', async () => {
    state.chart = 'SKR03'
    await expect(importDatev('owner-1', [bookingFile('S', '04', '1600', '4000')])).rejects.toThrow(/verwendet bereits SKR03/)
    expect(state.entries).toHaveLength(0)
  })

  it('records the first DATEV contract on a migrated SKR03 ledger profile', async () => {
    state.chart = 'SKR03'; state.accountLength = 4
    await importDatev('owner-1', [bookingFile('S')])
    expect(transaction.ledgerProfile.update).toHaveBeenCalledWith({
      where: { ownerId: 'owner-1' },
      data: { consultantNumber: '1', clientNumber: '1', accountLength: 4 },
    })
  })

  it('does not change the four-digit length of an initialized default ledger', async () => {
    state.chart = 'SKR03'; state.accountLength = 4
    await expect(importDatev('owner-1', [bookingFile('S', '03', '12000', '84000', 'scaled', 2025, '1', '5')]))
      .rejects.toThrow(/Sachkontenlänge/)
    expect(state.entries).toHaveLength(0)
  })

  it('rejects a different DATEV client or account length on later imports', async () => {
    await importDatev('owner-1', [bookingFile('S')])
    await expect(importDatev('owner-1', [bookingFile('S', '03', '1200', '8000', 'other-consultant', 2025, '1', '4', '2')])).rejects.toThrow(/Beraternummer/)
    await expect(importDatev('owner-1', [bookingFile('S', '03', '1200', '8000', 'other-client', 2025, '2')])).rejects.toThrow(/Mandantennummer/)
    await expect(importDatev('owner-1', [bookingFile('S', '03', '12000', '80000', 'other-length', 2025, '1', '5')])).rejects.toThrow(/Sachkontenlänge/)
    expect(state.entries).toHaveLength(1)
  })

  it('rejects DATEV fiscal years outside the ledger range', async () => {
    await expect(importDatev('owner-1', [bookingFile('S', '03', '1200', '8000', 'future', 9999)]))
      .rejects.toThrow(/1900 bis 2200/)
    expect(transaction.fiscalYear.upsert).not.toHaveBeenCalled()
  })

  it('rejects an existing account with a conflicting category', async () => {
    transaction.ledgerAccount.findMany.mockResolvedValueOnce([
      { number: 1200, id: 'account-1200', category: 'EXPENSE' },
      { number: 8000, id: 'account-8000', category: 'REVENUE' },
    ])
    await expect(importDatev('owner-1', [bookingFile('S')])).rejects.toThrow(/passt nicht zum DATEV-Kontenrahmen/)
    expect(state.entries).toHaveLength(0)
  })

  it('expands supported DATEV automatic tax keys into balanced net and tax lines', () => {
    expect(createDatevLines({
      bookingDate: '2025-01-01', amountCents: 11900, side: 'S', accountNumber: 4930, contraAccountNumber: 70001,
      documentNumber: '1', description: 'Expense', identity: '1', taxCode: '9',
      automaticTax: { kind: 'INPUT', rate: 19, accountNumber: 1576, splitSide: 'ACCOUNT' },
    })).toEqual([
      { accountNumber: 4930, debitCents: 10000, creditCents: 0 },
      { accountNumber: 1576, debitCents: 1900, creditCents: 0 },
      { accountNumber: 70001, debitCents: 0, creditCents: 11900 },
    ])
    expect(createDatevLines({
      bookingDate: '2025-01-01', amountCents: 1, side: 'S', accountNumber: 10001, contraAccountNumber: 8400,
      documentNumber: 'tiny', description: 'Tiny', identity: null,
      automaticTax: { kind: 'OUTPUT', rate: 19, accountNumber: 1776, splitSide: 'CONTRA' },
    })).toEqual([
      { accountNumber: 10001, debitCents: 1, creditCents: 0 },
      { accountNumber: 8400, debitCents: 0, creditCents: 1 },
    ])
    expect(createDatevLines({
      bookingDate: '2025-01-01', amountCents: 10000, side: 'S', accountNumber: 3123, contraAccountNumber: 70001,
      documentNumber: '3', description: 'Reverse charge', identity: null,
      reverseCharge: { rate: 19, inputTaxAccountNumber: 1577, outputTaxAccountNumber: 1787, baseSide: 'ACCOUNT' },
    })).toEqual([
      { accountNumber: 3123, debitCents: 10000, creditCents: 0 },
      { accountNumber: 70001, debitCents: 0, creditCents: 10000 },
      { accountNumber: 1577, debitCents: 1900, creditCents: 0 },
      { accountNumber: 1787, debitCents: 0, creditCents: 1900 },
    ])
    expect(createDatevLines({
      bookingDate: '2025-01-01', amountCents: 11900, side: 'H', accountNumber: 70001, contraAccountNumber: 4930,
      documentNumber: '2', description: 'Expense reversed', identity: null, taxCode: '9',
      automaticTax: { kind: 'INPUT', rate: 19, accountNumber: 1576, splitSide: 'CONTRA' },
    })).toEqual([
      { accountNumber: 70001, debitCents: 0, creditCents: 11900 },
      { accountNumber: 4930, debitCents: 10000, creditCents: 0 },
      { accountNumber: 1576, debitCents: 1900, creditCents: 0 },
    ])
  })

  it('keeps Generalumkehr turnover negative on the original sides', () => {
    expect(createDatevLines({
      bookingDate: '2025-01-01', amountCents: 100, side: 'S', accountNumber: 1200, contraAccountNumber: 8000,
      documentNumber: 'GU', description: 'Reversal', identity: 'gu', generalReversal: true,
    })).toEqual([
      { accountNumber: 1200, debitCents: -100, creditCents: 0 },
      { accountNumber: 8000, debitCents: 0, creditCents: -100 },
    ])
    expect(createDatevLines({
      bookingDate: '2025-01-01', amountCents: 11900, side: 'S', accountNumber: 4930, contraAccountNumber: 70001,
      documentNumber: 'GU-TAX', description: 'Tax reversal', identity: 'gu-tax', generalReversal: true, taxCode: '9',
      automaticTax: { kind: 'INPUT', rate: 19, accountNumber: 1576, splitSide: 'ACCOUNT' },
    })).toEqual([
      { accountNumber: 4930, debitCents: -10000, creditCents: 0 },
      { accountNumber: 1576, debitCents: -1900, creditCents: 0 },
      { accountNumber: 70001, debitCents: 0, creditCents: -11900 },
    ])
  })

  it('caps aggregate accounts before starting database work', () => {
    expect(() => validateDatevImportSize({ bookings: [], accounts: Array.from({ length: 1_001 }) as any[] })).toThrow(/höchstens 1000 Konten/)
    expect(() => validateDatevImportSize({ bookings: Array.from({ length: 201 }) as any[], accounts: [] })).toThrow(/höchstens 200 Buchungen/)
  })
})

function bookingFile(side: 'S' | 'H', chart = '03', account = '1200', contra = '8000', guid = 'guid-private', year = 2025, client = '1', accountLength = '4', consultant = '1') {
  const metadata = ['EXTF', '700', '21', 'Buchungsstapel', '13', 'export', '', 'BH', '', '', consultant, client, `${year}0101`, accountLength, `${year}0101`, `${year}1231`, '', '', '', '', '', 'EUR', '', '', '', '', chart, '']
  const headers = ['Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Buchungstext', 'Buchungs GUID']
  const row = ['12,34', side, account, contra, '', '1707', 'RE-1', 'Test', guid]
  return { name: 'bookings.csv', bytes: new TextEncoder().encode([metadata, headers, row].map(values => values.join(';')).join('\r\n')) }
}

function masterFile(account: string, name: string) {
  const metadata = ['EXTF', '700', '21', 'Debitoren/Kreditoren', '13', 'export', '', 'BH', '', '', '1', '1', '20250101', '4', '20250101', '20251231', '', '', '', '', '', 'EUR', '', '', '', '', '03', '']
  const rows = [metadata, ['Konto', 'Name (Adressattyp Unternehmen)'], [account, name]]
  return { name: 'master.csv', bytes: new TextEncoder().encode(rows.map(row => row.join(';')).join('\r\n')) }
}
