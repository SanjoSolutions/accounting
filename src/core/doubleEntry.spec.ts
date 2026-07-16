import { describe, expect, it } from 'vitest'
import {
  AccountingValidationError,
  createOpeningBalanceLines,
  createFinancialStatements,
  validateClosing,
  validateJournalEntry,
  validateClosingDate,
  validateClosingOrder,
  validatePostingOrder,
  type LedgerBalance,
} from './doubleEntry'

describe('double-entry journal', () => {
  it('accepts a balanced compound posting in integer cents', () => {
    expect(validateJournalEntry({
      bookingDate: '2026-03-12',
      documentNumber: 'ER-42',
      description: 'Büromaterial auf Ziel',
      lines: [
        { accountId: 'expense', debitCents: 10000, creditCents: 0 },
        { accountId: 'vat', debitCents: 1900, creditCents: 0 },
        { accountId: 'payable', debitCents: 0, creditCents: 11900 },
      ],
    }).lines).toHaveLength(3)
  })

  it('returns only validated journal fields', () => {
    const result = validateJournalEntry({
      bookingDate: '2026-03-12', documentNumber: 'ER-44', description: 'Sicher', ignored: 'top',
      lines: [
        { accountId: 'expense', debitCents: 100, creditCents: 0, id: 'caller-id' },
        { accountId: 'bank', debitCents: 0, creditCents: 100, journalEntryId: 'foreign' },
      ],
    })
    expect(result).not.toHaveProperty('ignored')
    expect(result.lines[0]).toEqual({ accountId: 'expense', debitCents: 100, creditCents: 0 })
  })

  it('rejects an unbalanced posting and a line with both sides', () => {
    expect(() => validateJournalEntry({
      bookingDate: '2026-03-12',
      documentNumber: 'ER-43',
      description: 'Fehler',
      lines: [
        { accountId: 'expense', debitCents: 10000, creditCents: 1 },
        { accountId: 'bank', debitCents: 0, creditCents: 9999 },
      ],
    })).toThrow(AccountingValidationError)
  })

  it('rejects a zero-effect debit and credit on the same account', () => {
    expect(() => validateJournalEntry({
      fiscalYear: 2026, bookingDate: '2026-01-10', documentNumber: 'B-1', description: 'Scheingeschäft',
      lines: [
        { accountId: 'bank', debitCents: 100, creditCents: 0 },
        { accountId: 'bank', debitCents: 0, creditCents: 100 },
      ],
    })).toThrow('mindestens zwei unterschiedliche Konten')
  })

  it('rejects malformed input and nonexistent calendar dates', () => {
    expect(() => validateJournalEntry({})).toThrow(AccountingValidationError)
    expect(() => validateJournalEntry({
      bookingDate: '2026-02-31', documentNumber: '1', description: 'Ungültig',
      lines: [{ accountId: 'a', debitCents: 100, creditCents: 0 }, { accountId: 'b', debitCents: 0, creditCents: 100 }],
    })).toThrow('Das Buchungsdatum ist ungültig.')
  })

  it('rejects cross-year postings and non-string account identifiers', () => {
    expect(() => validateJournalEntry({
      fiscalYear: 2025, bookingDate: '2026-01-01', documentNumber: '1', description: 'Falsches Jahr',
      lines: [{ accountId: 42, debitCents: 100, creditCents: 0 }, { accountId: 'b', debitCents: 0, creditCents: 100 }],
    })).toThrow(AccountingValidationError)
  })

  it('rejects cent amounts outside the persisted 32-bit integer range', () => {
    expect(() => validateJournalEntry({ bookingDate: '2026-01-01', documentNumber: '1', description: 'Zu groß', lines: [
      { accountId: 'a', debitCents: 3_000_000_000, creditCents: 0 }, { accountId: 'b', debitCents: 0, creditCents: 3_000_000_000 },
    ] })).toThrow('Betrag überschreitet den unterstützten Höchstwert.')
  })
})

describe('annual financial statements', () => {
  const balances: LedgerBalance[] = [
    { accountId: 'bank', number: 1200, name: 'Bank', category: 'ASSET', eBilanzPosition: 'bs.ass.currAss.cashEquiv.bank', debitCents: 150000, creditCents: 0, balanceCents: 150000 },
    { accountId: 'capital', number: 2900, name: 'Eigenkapital', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity', debitCents: 0, creditCents: 100000, balanceCents: -100000 },
    { accountId: 'revenue', number: 8400, name: 'Erlöse', category: 'REVENUE', eBilanzPosition: 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput', debitCents: 0, creditCents: 70000, balanceCents: -70000 },
    { accountId: 'expense', number: 4930, name: 'Bürobedarf', category: 'EXPENSE', eBilanzPosition: 'is.netIncome.regular.operatingTC.otherCost', debitCents: 20000, creditCents: 0, balanceCents: 20000 },
  ]

  it('automatically rolls profit into reported equity', () => {
    const result = createFinancialStatements(balances)
    expect(result.netIncomeCents).toBe(50000)
    expect(result.equityCents).toBe(150000)
    expect(result.balanceDifferenceCents).toBe(0)
  })

  it('blocks closing when a non-zero account has no taxonomy mapping', () => {
    const result = createFinancialStatements([{ ...balances[0], eBilanzPosition: null }])
    expect(validateClosing(result)).toContain('Konto 1200 Bank hat keine E-Bilanz-Zuordnung.')
  })

  it('carries permanent balances and annual profit into the next-year opening entry', () => {
    const statements = createFinancialStatements(balances)
    expect(createOpeningBalanceLines(statements)).toEqual([
      { accountId: 'bank', debitCents: 150000, creditCents: 0 },
      { accountId: 'capital', debitCents: 0, creditCents: 150000 },
    ])
  })

  it('rejects closing on or before the configured fiscal-year end', () => {
    expect(() => validateClosingDate(new Date('2026-12-31T23:59:59.999Z'), new Date('2026-07-16T12:00:00Z'))).toThrow('Das Geschäftsjahr kann erst nach dem')
    expect(() => validateClosingDate(new Date('2025-12-31T23:59:59.999Z'), new Date('2026-07-16T12:00:00Z'))).not.toThrow()
  })

  it('splits large aggregate opening balances into database-safe lines', () => {
    const large = createFinancialStatements([
      { accountId: 'bank', number: 1200, name: 'Bank', category: 'ASSET', eBilanzPosition: 'bank', debitCents: 3_000_000_000, creditCents: 0, balanceCents: 3_000_000_000 },
      { accountId: 'capital', number: 2900, name: 'Kapital', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity', debitCents: 0, creditCents: 3_000_000_000, balanceCents: -3_000_000_000 },
    ])
    const lines = createOpeningBalanceLines(large)
    expect(Math.max(...lines.flatMap(line => [line.debitCents, line.creditCents]))).toBe(2_147_483_647)
    expect(lines.reduce((sum, line) => sum + line.debitCents, 0)).toBe(3_000_000_000)
    expect(lines.reduce((sum, line) => sum + line.creditCents, 0)).toBe(3_000_000_000)
  })

  it('allocates annual profit exactly once with multiple total-equity accounts', () => {
    const result = createFinancialStatements([
      { accountId: 'bank', number: 1200, name: 'Bank', category: 'ASSET', eBilanzPosition: 'bank', debitCents: 150000, creditCents: 0, balanceCents: 150000 },
      { accountId: 'capital-a', number: 2900, name: 'Kapital A', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity', debitCents: 0, creditCents: 50000, balanceCents: -50000 },
      { accountId: 'capital-b', number: 2901, name: 'Kapital B', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity', debitCents: 0, creditCents: 50000, balanceCents: -50000 },
      { accountId: 'revenue', number: 8400, name: 'Erlös', category: 'REVENUE', eBilanzPosition: 'revenue', debitCents: 0, creditCents: 50000, balanceCents: -50000 },
    ])
    const lines = createOpeningBalanceLines(result)
    expect(lines.reduce((sum, line) => sum + line.creditCents, 0)).toBe(150000)
  })

  it('requires earlier fiscal years with activity to be closed first', () => {
    expect(() => validateClosingOrder(2026, [{ year: 2025, status: 'OPEN', hasEntries: true }])).toThrow('2025 muss zuerst abgeschlossen')
    expect(() => validateClosingOrder(2026, [{ year: 2025, status: 'OPEN', hasEntries: false }])).not.toThrow()
  })

  it('rejects backdated postings before an already closed successor year', () => {
    expect(() => validatePostingOrder(2025, [2026])).toThrow('Folgejahr 2026 bereits abgeschlossen')
    expect(() => validatePostingOrder(2026, [])).not.toThrow()
  })
})
