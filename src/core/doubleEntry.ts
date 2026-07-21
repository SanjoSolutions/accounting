export const accountCategories = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE',
] as const
export const MAX_DATABASE_CENTS = 2_147_483_647

export type AccountCategory = typeof accountCategories[number]

export interface PostingLineInput {
  accountId: string
  debitCents: number
  creditCents: number
  taxCode?: string
}

export interface BookingAccountChoice {
  id: string
  category: string
}

export interface BookingAccountSelection {
  accountId: string
}

export interface JournalEntryInput {
  fiscalYear?: number
  bookingDate: string
  documentNumber: string
  description: string
  lines: PostingLineInput[]
  documentIds?: string[]
}

export interface LedgerBalance {
  accountId: string
  number: number
  name: string
  category: AccountCategory
  eBilanzPosition: string | null
  debitCents: number
  creditCents: number
  balanceCents: number
}

export interface FinancialStatements {
  assetsCents: number
  liabilitiesCents: number
  equityBeforeProfitCents: number
  revenueCents: number
  expenseCents: number
  netIncomeCents: number
  equityCents: number
  balanceDifferenceCents: number
  balances: LedgerBalance[]
}

export interface OpeningBalanceLine { accountId: string; debitCents: number; creditCents: number }

export class AccountingValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(issues.join(' '))
    this.name = 'AccountingValidationError'
  }
}

export function isBalanceSheetAccountCategory(category: string): category is Extract<AccountCategory, 'ASSET' | 'LIABILITY' | 'EQUITY'> {
  return category === 'ASSET' || category === 'LIABILITY' || category === 'EQUITY'
}

export function availableBookingAccounts<T extends BookingAccountChoice>(
  accounts: readonly T[],
  lines: readonly BookingAccountSelection[],
  lineIndex: number,
): T[] {
  const accountsById = new Map(accounts.map(account => [account.id, account]))
  const priorIds = lines.slice(0, lineIndex).map(line => line.accountId).filter(Boolean)
  const priorAccounts = priorIds.map(id => accountsById.get(id))
  if (priorAccounts.some(account => !account)) return []
  const needsBalanceSheetAccount = priorAccounts.length > 0
    && priorAccounts.every(account => account && !isBalanceSheetAccountCategory(account.category))
  const alreadySelected = new Set(priorIds)
  return accounts.filter(account => !alreadySelected.has(account.id)
    && (!needsBalanceSheetAccount || isBalanceSheetAccountCategory(account.category)))
}

export function sanitizeBookingAccountSelections<T extends BookingAccountSelection>(
  accounts: readonly BookingAccountChoice[],
  lines: readonly T[],
): T[] {
  const sanitized = lines.map(line => ({ ...line }))
  for (const [index, line] of sanitized.entries()) {
    if (line.accountId && !availableBookingAccounts(accounts, sanitized, index).some(account => account.id === line.accountId)) {
      line.accountId = ''
    }
  }
  return sanitized
}

export function validateManualAccountCombination(
  accounts: readonly BookingAccountChoice[],
  lines: readonly BookingAccountSelection[],
): void {
  const accountsById = new Map(accounts.map(account => [account.id, account]))
  const selectedAccounts = lines.map(line => accountsById.get(line.accountId))
  if (selectedAccounts.some(account => !account)) return
  if (!selectedAccounts.some(account => account && isBalanceSheetAccountCategory(account.category))) {
    throw new AccountingValidationError(['Manuelle Buchungen müssen mindestens ein Aktiv-, Passiv- oder Eigenkapitalkonto enthalten; reine GuV-Umbuchungen sind nicht zulässig.'])
  }
}

export function validateJournalEntry(input: unknown): JournalEntryInput {
  const issues: string[] = []
  if (!input || typeof input !== 'object') throw new AccountingValidationError(['Der Buchungssatz muss ein Objekt sein.'])
  const candidate = input as Partial<JournalEntryInput>
  if (typeof candidate.bookingDate !== 'string') issues.push('Das Buchungsdatum ist erforderlich.')
  if (typeof candidate.documentNumber !== 'string') issues.push('Die Belegnummer muss Text sein.')
  if (typeof candidate.description !== 'string') issues.push('Der Buchungstext muss Text sein.')
  if (!Array.isArray(candidate.lines)) issues.push('Die Buchungszeilen müssen als Liste angegeben werden.')
  if (issues.length) throw new AccountingValidationError(issues)

  const validInput = candidate as JournalEntryInput
  const [year, month, day] = validInput.bookingDate.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(validInput.bookingDate) || Number.isNaN(date.valueOf()) ||
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    issues.push('Das Buchungsdatum ist ungültig.')
  }
  if (validInput.fiscalYear !== undefined && (!Number.isInteger(validInput.fiscalYear) || validInput.fiscalYear !== year)) {
    issues.push('Das Buchungsdatum liegt nicht im ausgewählten Geschäftsjahr.')
  }
  if (!validInput.documentNumber.trim()) issues.push('Eine eindeutige Belegnummer ist erforderlich.')
  if (!validInput.description.trim()) issues.push('Ein Buchungstext ist erforderlich.')
  if (validInput.lines.length < 2) issues.push('Ein Buchungssatz benötigt mindestens zwei Konten.')
  const distinctAccounts = new Set(validInput.lines
    .filter((line): line is PostingLineInput => Boolean(line && typeof line === 'object' && typeof (line as PostingLineInput).accountId === 'string'))
    .map(line => line.accountId.trim())
    .filter(Boolean))
  if (validInput.lines.length >= 2 && distinctAccounts.size < 2) issues.push('Ein Buchungssatz benötigt mindestens zwei unterschiedliche Konten.')

  let debit = 0
  let credit = 0
  for (const [index, rawLine] of validInput.lines.entries()) {
    if (!rawLine || typeof rawLine !== 'object') { issues.push(`Zeile ${index + 1}: Ungültiges Format.`); continue }
    const line = rawLine as PostingLineInput
    if (typeof line.accountId !== 'string' || !line.accountId.trim()) issues.push(`Zeile ${index + 1}: Konto fehlt oder ist ungültig.`)
    if (line.taxCode !== undefined && typeof line.taxCode !== 'string') issues.push(`Zeile ${index + 1}: Steuerschlüssel ist ungültig.`)
    if (!Number.isSafeInteger(line.debitCents) || !Number.isSafeInteger(line.creditCents)) {
      issues.push(`Zeile ${index + 1}: Beträge müssen centgenau sein.`)
      continue
    }
    if (line.debitCents > MAX_DATABASE_CENTS || line.creditCents > MAX_DATABASE_CENTS) {
      issues.push(`Zeile ${index + 1}: Betrag überschreitet den unterstützten Höchstwert.`)
    }
    if (line.debitCents < 0 || line.creditCents < 0) {
      issues.push(`Zeile ${index + 1}: Negative Beträge sind nicht zulässig.`)
    }
    if ((line.debitCents === 0) === (line.creditCents === 0)) {
      issues.push(`Zeile ${index + 1}: Genau eine Seite (Soll oder Haben) muss einen Betrag enthalten.`)
    }
    debit += line.debitCents
    credit += line.creditCents
  }
  if (debit !== credit) issues.push(`Soll und Haben unterscheiden sich um ${formatCents(Math.abs(debit - credit))}.`)
  if (debit === 0) issues.push('Der Buchungssatz darf nicht leer sein.')
  if (issues.length) throw new AccountingValidationError(issues)
  return {
    fiscalYear: validInput.fiscalYear,
    bookingDate: validInput.bookingDate,
    documentNumber: validInput.documentNumber,
    description: validInput.description,
    lines: validInput.lines.map(line => ({
      accountId: line.accountId,
      debitCents: line.debitCents,
      creditCents: line.creditCents,
      ...(line.taxCode === undefined ? {} : { taxCode: line.taxCode }),
    })),
  }
}

export function createFinancialStatements(balances: LedgerBalance[]): FinancialStatements {
  const sum = (category: AccountCategory) => balances
    .filter(item => item.category === category)
    .reduce((total, item) => total + normalBalance(item), 0)

  const assetsCents = sum('ASSET')
  const liabilitiesCents = sum('LIABILITY')
  const equityBeforeProfitCents = sum('EQUITY')
  const revenueCents = sum('REVENUE')
  const expenseCents = sum('EXPENSE')
  const netIncomeCents = revenueCents - expenseCents
  const equityCents = equityBeforeProfitCents + netIncomeCents

  return {
    assetsCents,
    liabilitiesCents,
    equityBeforeProfitCents,
    revenueCents,
    expenseCents,
    netIncomeCents,
    equityCents,
    balanceDifferenceCents: assetsCents - liabilitiesCents - equityCents,
    balances,
  }
}

export function validateClosing(statements: FinancialStatements): string[] {
  const issues: string[] = []
  if (statements.balanceDifferenceCents !== 0) {
    issues.push(`Die Bilanz ist nicht ausgeglichen (${formatCents(statements.balanceDifferenceCents)}).`)
  }
  for (const balance of statements.balances) {
    if (balance.balanceCents !== 0 && !balance.eBilanzPosition) {
      issues.push(`Konto ${balance.number} ${balance.name} hat keine E-Bilanz-Zuordnung.`)
    }
  }
  return issues
}

export function validateClosingDate(endsAt: Date, now = new Date()): void {
  if (now <= endsAt) throw new AccountingValidationError([`Das Geschäftsjahr kann erst nach dem ${endsAt.toLocaleDateString('de-DE')} abgeschlossen werden.`])
}

export function validateClosingOrder(year: number, predecessors: Array<{ year: number; status: string; hasEntries: boolean }>): void {
  const open = predecessors.find(item => item.year < year && item.status !== 'CLOSED' && item.hasEntries)
  if (open) throw new AccountingValidationError([`Das bebuchte Geschäftsjahr ${open.year} muss zuerst abgeschlossen und vorgetragen werden.`])
}

export function validatePostingOrder(year: number, closedSuccessorYears: number[]): void {
  const successor = closedSuccessorYears.find(successorYear => successorYear > year)
  if (successor) throw new AccountingValidationError([`In ${year} kann nicht mehr gebucht werden, weil das Folgejahr ${successor} bereits abgeschlossen ist.`])
}

export function createOpeningBalanceLines(statements: FinancialStatements): OpeningBalanceLine[] {
  let profitAllocated = false
  return statements.balances
    .filter(balance => balance.category === 'ASSET' || balance.category === 'LIABILITY' || balance.category === 'EQUITY')
    .flatMap(balance => {
      let normal = balance.category === 'ASSET' ? balance.debitCents - balance.creditCents : balance.creditCents - balance.debitCents
      if (!profitAllocated && balance.category === 'EQUITY' && balance.eBilanzPosition === 'bs.eqLiab.equity') {
        normal += statements.netIncomeCents
        profitAllocated = true
      }
      const debit = balance.category === 'ASSET' ? Math.max(normal, 0) : Math.max(-normal, 0)
      const credit = balance.category === 'ASSET' ? Math.max(-normal, 0) : Math.max(normal, 0)
      const lines: OpeningBalanceLine[] = []
      let remainingDebit = debit
      let remainingCredit = credit
      while (remainingDebit > 0 || remainingCredit > 0) {
        const debitCents = Math.min(remainingDebit, MAX_DATABASE_CENTS)
        const creditCents = Math.min(remainingCredit, MAX_DATABASE_CENTS)
        lines.push({ accountId: balance.accountId, debitCents, creditCents })
        remainingDebit -= debitCents
        remainingCredit -= creditCents
      }
      return lines
    })
    .filter(line => line.debitCents !== 0 || line.creditCents !== 0)
}

function normalBalance(balance: LedgerBalance): number {
  if (balance.category === 'ASSET' || balance.category === 'EXPENSE') {
    return balance.debitCents - balance.creditCents
  }
  return balance.creditCents - balance.debitCents
}

export function formatCents(value: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value / 100)
}
