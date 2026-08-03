/**
 * Deterministic HGB statement presentation for the deliberately narrow
 * HGB-DE-2024.1 product scope. The statutory layouts are based on HGB
 * §§ 265, 266 and 275. Legal applicability is decided by hgbClose.ts.
 * Sources: https://www.gesetze-im-internet.de/hgb/__265.html
 *          https://www.gesetze-im-internet.de/hgb/__266.html
 *          https://www.gesetze-im-internet.de/hgb/__275.html
 *
 * Monetary values are integer cents. Any incomplete mapping, malformed rule
 * set or unsafe arithmetic aborts the report instead of producing estimates.
 */

export type HgbStatementSize = 'MICRO' | 'SMALL'
export type HgbIncomeStatementMethod = 'GKV' | 'UKV'
export type HgbNormalBalance = 'DEBIT' | 'CREDIT'
export type HgbStatement = 'BALANCE_SHEET' | 'INCOME_STATEMENT'
export type HgbLineRole = 'ASSET' | 'EQUITY_LIABILITY' | 'INCOME' | 'EXPENSE'

export interface HgbStatementLineDefinition {
  id: string
  label: string
  statement: HgbStatement
  parentId?: string
  role?: HgbLineRole
  derived?: 'NET_INCOME' | 'PROFIT_AFTER_TAX' | 'GROSS_PROFIT'
}

export interface HgbStatementRuleSet {
  version: 'HGB-DE-2024.1'
  size: HgbStatementSize
  method: HgbIncomeStatementMethod
  lines: readonly HgbStatementLineDefinition[]
}

export interface HgbAccountMapping {
  accountNumber: string
  lineId: string
  normalBalance: HgbNormalBalance
  presentationSign: 1 | -1
  effectiveFrom: string
  effectiveTo?: string
}

export interface HgbTrialBalanceAccount {
  accountNumber: string
  openingDebitCents: number
  openingCreditCents: number
  debitCents: number
  creditCents: number
}

export interface HgbStatementPeriod {
  startsAt: string
  endsAt: string
  accounts: readonly HgbTrialBalanceAccount[]
}

export interface HgbComparativeExpectation {
  lineId: string
  amountCents: number
}

export interface HgbStatementInput {
  ruleSet: HgbStatementRuleSet
  current: HgbStatementPeriod
  comparative: HgbStatementPeriod
  mappings: readonly HgbAccountMapping[]
  expectedComparativeLeaves: readonly HgbComparativeExpectation[]
}

export interface HgbStatementLineResult extends HgbStatementLineDefinition {
  amountCents: number
  comparativeAmountCents: number
  changeCents: number
}

export interface HgbMappedAccountResult {
  period: 'CURRENT' | 'COMPARATIVE'
  accountNumber: string
  lineId: string
  normalBalanceAmountCents: number
  statementAmountCents: number
}

export interface HgbStatementResult {
  ruleSetVersion: HgbStatementRuleSet['version']
  size: HgbStatementSize
  method: HgbIncomeStatementMethod
  lines: HgbStatementLineResult[]
  mappedAccounts: HgbMappedAccountResult[]
  currentNetIncomeCents: number
  comparativeNetIncomeCents: number
  checks: {
    currentTrialBalanceCents: 0
    comparativeTrialBalanceCents: 0
    currentBalanceSheetDifferenceCents: 0
    comparativeBalanceSheetDifferenceCents: 0
    currentIncomeStatementDifferenceCents: 0
    comparativeIncomeStatementDifferenceCents: 0
    comparativeExpectedDifferenceCents: 0
  }
}

export class HgbStatementValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`HGB statements cannot be generated: ${issues.join(' ')}`)
    this.name = 'HgbStatementValidationError'
  }
}

const dateOnly = /^\d{4}-\d{2}-\d{2}$/
const validDate = (value: string) => {
  if (!dateOnly.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
const safe = (value: number, context: string) => {
  if (!Number.isSafeInteger(value)) throw new HgbStatementValidationError([`${context} must be a safe integer number of cents.`])
  return value
}
const add = (left: number, right: number, context: string) => safe(left + right, `${context} arithmetic result`)
const subtract = (left: number, right: number, context: string) => safe(left - right, `${context} arithmetic result`)

function line(id: string, label: string, statement: HgbStatement, parentId?: string, role?: HgbLineRole, derived?: HgbStatementLineDefinition['derived']): HgbStatementLineDefinition {
  return { id, label, statement, ...(parentId ? { parentId } : {}), ...(role ? { role } : {}), ...(derived ? { derived } : {}) }
}

function balanceSheetLines(size: HgbStatementSize): HgbStatementLineDefinition[] {
  const roots = [
    line('BS.ASSETS', 'Aktiva', 'BALANCE_SHEET'),
    line('BS.EQUITY_LIABILITIES', 'Passiva', 'BALANCE_SHEET'),
  ]
  const top = [
    line('BS.A.A', 'A. Anlagevermögen', 'BALANCE_SHEET', 'BS.ASSETS', 'ASSET'),
    line('BS.A.B', 'B. Umlaufvermögen', 'BALANCE_SHEET', 'BS.ASSETS', 'ASSET'),
    line('BS.A.C', 'C. Rechnungsabgrenzungsposten', 'BALANCE_SHEET', 'BS.ASSETS', 'ASSET'),
    line('BS.A.D', 'D. Aktive latente Steuern', 'BALANCE_SHEET', 'BS.ASSETS', 'ASSET'),
    line('BS.A.E', 'E. Aktiver Unterschiedsbetrag aus der Vermögensverrechnung', 'BALANCE_SHEET', 'BS.ASSETS', 'ASSET'),
    line('BS.P.A', 'A. Eigenkapital', 'BALANCE_SHEET', 'BS.EQUITY_LIABILITIES', 'EQUITY_LIABILITY', size === 'MICRO' ? 'NET_INCOME' : undefined),
    line('BS.P.B', 'B. Rückstellungen', 'BALANCE_SHEET', 'BS.EQUITY_LIABILITIES', 'EQUITY_LIABILITY'),
    line('BS.P.C', 'C. Verbindlichkeiten', 'BALANCE_SHEET', 'BS.EQUITY_LIABILITIES', 'EQUITY_LIABILITY'),
    line('BS.P.D', 'D. Rechnungsabgrenzungsposten', 'BALANCE_SHEET', 'BS.EQUITY_LIABILITIES', 'EQUITY_LIABILITY'),
    line('BS.P.E', 'E. Passive latente Steuern', 'BALANCE_SHEET', 'BS.EQUITY_LIABILITIES', 'EQUITY_LIABILITY'),
  ]
  if (size === 'MICRO') return [...roots, ...top]
  const small = [
    ...[['BS.A.A.I', 'I. Immaterielle Vermögensgegenstände', 'BS.A.A'], ['BS.A.A.II', 'II. Sachanlagen', 'BS.A.A'], ['BS.A.A.III', 'III. Finanzanlagen', 'BS.A.A'], ['BS.A.B.I', 'I. Vorräte', 'BS.A.B'], ['BS.A.B.II', 'II. Forderungen und sonstige Vermögensgegenstände', 'BS.A.B'], ['BS.A.B.III', 'III. Wertpapiere', 'BS.A.B'], ['BS.A.B.IV', 'IV. Kassenbestand, Bundesbankguthaben, Guthaben bei Kreditinstituten und Schecks', 'BS.A.B']].map(([id, label, parent]) => line(id, label, 'BALANCE_SHEET', parent, 'ASSET')),
    ...[['BS.P.A.I', 'I. Gezeichnetes Kapital', 'BS.P.A'], ['BS.P.A.II', 'II. Kapitalrücklage', 'BS.P.A'], ['BS.P.A.III', 'III. Gewinnrücklagen', 'BS.P.A'], ['BS.P.A.IV', 'IV. Gewinnvortrag/Verlustvortrag', 'BS.P.A']].map(([id, label, parent]) => line(id, label, 'BALANCE_SHEET', parent, 'EQUITY_LIABILITY')),
    line('BS.P.A.V', 'V. Jahresüberschuss/Jahresfehlbetrag', 'BALANCE_SHEET', 'BS.P.A', 'EQUITY_LIABILITY', 'NET_INCOME'),
  ]
  return [...roots, ...top, ...small]
}

function incomeStatementLines(size: HgbStatementSize, method: HgbIncomeStatementMethod): HgbStatementLineDefinition[] {
  const root = line('IS', 'Gewinn- und Verlustrechnung', 'INCOME_STATEMENT', undefined, undefined, 'NET_INCOME')
  if (size === 'MICRO') return [root,
    line('IS.M.1', '1. Umsatzerlöse', 'INCOME_STATEMENT', 'IS', 'INCOME'),
    line('IS.M.2', '2. Sonstige Erträge', 'INCOME_STATEMENT', 'IS', 'INCOME'),
    line('IS.M.3', '3. Materialaufwand', 'INCOME_STATEMENT', 'IS', 'EXPENSE'),
    line('IS.M.4', '4. Personalaufwand', 'INCOME_STATEMENT', 'IS', 'EXPENSE'),
    line('IS.M.5', '5. Abschreibungen', 'INCOME_STATEMENT', 'IS', 'EXPENSE'),
    line('IS.M.6', '6. Sonstige Aufwendungen', 'INCOME_STATEMENT', 'IS', 'EXPENSE'),
    line('IS.M.7', '7. Steuern', 'INCOME_STATEMENT', 'IS', 'EXPENSE'),
    line('IS.M.8', '8. Jahresüberschuss/Jahresfehlbetrag', 'INCOME_STATEMENT', 'IS', undefined, 'NET_INCOME'),
  ]
  const common = [
    line(`IS.${method}.FIN.1`, 'Erträge aus Beteiligungen', 'INCOME_STATEMENT', 'IS', 'INCOME'),
    line(`IS.${method}.FIN.2`, 'Erträge aus anderen Wertpapieren und Ausleihungen des Finanzanlagevermögens', 'INCOME_STATEMENT', 'IS', 'INCOME'),
    line(`IS.${method}.FIN.3`, 'Sonstige Zinsen und ähnliche Erträge', 'INCOME_STATEMENT', 'IS', 'INCOME'),
    line(`IS.${method}.FIN.4`, 'Abschreibungen auf Finanzanlagen und auf Wertpapiere des Umlaufvermögens', 'INCOME_STATEMENT', 'IS', 'EXPENSE'),
    line(`IS.${method}.FIN.5`, 'Zinsen und ähnliche Aufwendungen', 'INCOME_STATEMENT', 'IS', 'EXPENSE'),
    line(`IS.${method}.TAX.INCOME`, 'Steuern vom Einkommen und vom Ertrag', 'INCOME_STATEMENT', 'IS', 'EXPENSE'),
    line(`IS.${method}.AFTER_TAX`, 'Ergebnis nach Steuern', 'INCOME_STATEMENT', 'IS', undefined, 'PROFIT_AFTER_TAX'),
    line(`IS.${method}.TAX.OTHER`, 'Sonstige Steuern', 'INCOME_STATEMENT', 'IS', 'EXPENSE'),
    line(`IS.${method}.NET`, 'Jahresüberschuss/Jahresfehlbetrag', 'INCOME_STATEMENT', 'IS', undefined, 'NET_INCOME'),
  ]
  if (method === 'GKV') return [root,
    line('IS.GKV.1', 'Umsatzerlöse', 'INCOME_STATEMENT', 'IS', 'INCOME'), line('IS.GKV.2', 'Bestandsveränderungen', 'INCOME_STATEMENT', 'IS', 'INCOME'), line('IS.GKV.3', 'Andere aktivierte Eigenleistungen', 'INCOME_STATEMENT', 'IS', 'INCOME'), line('IS.GKV.4', 'Sonstige betriebliche Erträge', 'INCOME_STATEMENT', 'IS', 'INCOME'),
    line('IS.GKV.5', 'Materialaufwand', 'INCOME_STATEMENT', 'IS'), line('IS.GKV.5.A', 'Aufwendungen für Roh-, Hilfs- und Betriebsstoffe und bezogene Waren', 'INCOME_STATEMENT', 'IS.GKV.5', 'EXPENSE'), line('IS.GKV.5.B', 'Aufwendungen für bezogene Leistungen', 'INCOME_STATEMENT', 'IS.GKV.5', 'EXPENSE'),
    line('IS.GKV.6', 'Personalaufwand', 'INCOME_STATEMENT', 'IS'), line('IS.GKV.6.A', 'Löhne und Gehälter', 'INCOME_STATEMENT', 'IS.GKV.6', 'EXPENSE'), line('IS.GKV.6.B', 'Soziale Abgaben und Aufwendungen für Altersversorgung und Unterstützung', 'INCOME_STATEMENT', 'IS.GKV.6', 'EXPENSE'),
    line('IS.GKV.7', 'Abschreibungen', 'INCOME_STATEMENT', 'IS'), line('IS.GKV.7.A', 'Abschreibungen auf immaterielle Vermögensgegenstände und Sachanlagen', 'INCOME_STATEMENT', 'IS.GKV.7', 'EXPENSE'), line('IS.GKV.7.B', 'Abschreibungen auf Vermögensgegenstände des Umlaufvermögens', 'INCOME_STATEMENT', 'IS.GKV.7', 'EXPENSE'),
    line('IS.GKV.8', 'Sonstige betriebliche Aufwendungen', 'INCOME_STATEMENT', 'IS', 'EXPENSE'), ...common]
  return [root,
    line('IS.UKV.1', 'Umsatzerlöse', 'INCOME_STATEMENT', 'IS', 'INCOME'), line('IS.UKV.2', 'Herstellungskosten der zur Erzielung der Umsatzerlöse erbrachten Leistungen', 'INCOME_STATEMENT', 'IS', 'EXPENSE'), line('IS.UKV.3', 'Bruttoergebnis vom Umsatz', 'INCOME_STATEMENT', 'IS', undefined, 'GROSS_PROFIT'), line('IS.UKV.4', 'Vertriebskosten', 'INCOME_STATEMENT', 'IS', 'EXPENSE'), line('IS.UKV.5', 'Allgemeine Verwaltungskosten', 'INCOME_STATEMENT', 'IS', 'EXPENSE'), line('IS.UKV.6', 'Sonstige betriebliche Erträge', 'INCOME_STATEMENT', 'IS', 'INCOME'), line('IS.UKV.7', 'Sonstige betriebliche Aufwendungen', 'INCOME_STATEMENT', 'IS', 'EXPENSE'), ...common]
}

export function createHgbStatementRuleSet(size: HgbStatementSize, method: HgbIncomeStatementMethod): HgbStatementRuleSet {
  if (!['MICRO', 'SMALL'].includes(size) || !['GKV', 'UKV'].includes(method)) throw new HgbStatementValidationError(['Only MICRO/SMALL and GKV/UKV are supported by HGB-DE-2024.1.'])
  return { version: 'HGB-DE-2024.1', size, method, lines: [...balanceSheetLines(size), ...incomeStatementLines(size, method)] }
}

function validatePeriod(period: HgbStatementPeriod, name: string): void {
  if (!validDate(period.startsAt) || !validDate(period.endsAt) || period.startsAt > period.endsAt) throw new HgbStatementValidationError([`${name} fiscal-period dates are invalid.`])
  const seen = new Set<string>()
  let openingDebit = 0; let openingCredit = 0; let debit = 0; let credit = 0
  for (const account of period.accounts) {
    if (!account.accountNumber.trim() || seen.has(account.accountNumber)) throw new HgbStatementValidationError([`${name} contains a missing or duplicate account number.`])
    seen.add(account.accountNumber)
    for (const key of ['openingDebitCents', 'openingCreditCents', 'debitCents', 'creditCents'] as const) {
      safe(account[key], `${name} ${account.accountNumber} ${key}`)
      if (account[key] < 0) throw new HgbStatementValidationError([`${name} ${account.accountNumber} ${key} cannot be negative.`])
    }
    if (account.openingDebitCents && account.openingCreditCents) throw new HgbStatementValidationError([`${name} ${account.accountNumber} cannot have both debit and credit opening balances.`])
    openingDebit = add(openingDebit, account.openingDebitCents, `${name} opening debits`); openingCredit = add(openingCredit, account.openingCreditCents, `${name} opening credits`)
    debit = add(debit, account.debitCents, `${name} period debits`); credit = add(credit, account.creditCents, `${name} period credits`)
  }
  if (openingDebit !== openingCredit) throw new HgbStatementValidationError([`${name} opening trial balance does not balance by ${openingDebit - openingCredit} cents.`])
  if (debit !== credit) throw new HgbStatementValidationError([`${name} period trial balance does not balance by ${debit - credit} cents.`])
}

function validateRuleSet(ruleSet: HgbStatementRuleSet) {
  if (ruleSet.version !== 'HGB-DE-2024.1') throw new HgbStatementValidationError(['The statement rule-set version is unsupported.'])
  const registered = createHgbStatementRuleSet(ruleSet.size, ruleSet.method)
  if (JSON.stringify(ruleSet.lines) !== JSON.stringify(registered.lines)) throw new HgbStatementValidationError([`The ${ruleSet.size}/${ruleSet.method} statement layout does not match the registered HGB-DE-2024.1 profile.`])
  const byId = new Map(ruleSet.lines.map(item => [item.id, item]))
  if (byId.size !== ruleSet.lines.length) throw new HgbStatementValidationError(['Statement line identifiers must be unique.'])
  for (const item of ruleSet.lines) {
    if (item.parentId && (!byId.has(item.parentId) || byId.get(item.parentId)?.statement !== item.statement)) throw new HgbStatementValidationError([`Statement line ${item.id} has an invalid parent.`])
    const visited = new Set<string>(); let cursor: HgbStatementLineDefinition | undefined = item
    while (cursor?.parentId) { if (visited.has(cursor.id)) throw new HgbStatementValidationError([`Statement hierarchy contains a cycle at ${item.id}.`]); visited.add(cursor.id); cursor = byId.get(cursor.parentId) }
  }
  return byId
}

function producePeriod(period: HgbStatementPeriod, periodName: 'CURRENT' | 'COMPARATIVE', rules: HgbStatementRuleSet, byId: Map<string, HgbStatementLineDefinition>, mappings: readonly HgbAccountMapping[]) {
  const leafAmounts = new Map<string, number>()
  const mappedAccounts: HgbMappedAccountResult[] = []
  const children = new Set(rules.lines.map(item => item.parentId).filter(Boolean))
  for (const account of period.accounts) {
    const activity = add(account.openingDebitCents, account.openingCreditCents, 'nonzero account detection') || add(account.debitCents, account.creditCents, 'nonzero account detection')
    if (!activity) continue
    const effective = mappings.filter(mapping => mapping.accountNumber === account.accountNumber && mapping.effectiveFrom <= period.endsAt && (!mapping.effectiveTo || mapping.effectiveTo >= period.endsAt))
    if (effective.length !== 1) throw new HgbStatementValidationError([`${periodName} nonzero account ${account.accountNumber} has ${effective.length} effective mappings; exactly one is required.`])
    const mapping = effective[0]; const target = byId.get(mapping.lineId)
    if (!target || children.has(target.id) || !target.role) throw new HgbStatementValidationError([`${periodName} account ${account.accountNumber} mapping does not target an account-bearing leaf statement line.`])
    if (!validDate(mapping.effectiveFrom) || mapping.effectiveTo && (!validDate(mapping.effectiveTo) || mapping.effectiveTo < mapping.effectiveFrom)) throw new HgbStatementValidationError([`Account ${account.accountNumber} mapping effective dates are invalid.`])
    const expectedRawSign = target.role === 'ASSET' || target.role === 'EXPENSE' ? 1 : -1
    const rawSign = (mapping.normalBalance === 'DEBIT' ? 1 : mapping.normalBalance === 'CREDIT' ? -1 : 0) * mapping.presentationSign
    if (![-1, 1].includes(mapping.presentationSign) || rawSign !== expectedRawSign) throw new HgbStatementValidationError([`Account ${account.accountNumber} normal balance and presentation sign are incompatible with ${target.role}.`])
    if (target.statement === 'INCOME_STATEMENT' && (account.openingDebitCents !== 0 || account.openingCreditCents !== 0)) throw new HgbStatementValidationError([`${periodName} income-statement account ${account.accountNumber} has a nonzero opening balance.`])
    const openingNet = subtract(account.openingDebitCents, account.openingCreditCents, 'opening balance')
    const periodNet = subtract(account.debitCents, account.creditCents, 'period balance')
    const raw = target.statement === 'BALANCE_SHEET' ? add(openingNet, periodNet, 'closing balance') : periodNet
    const normal = mapping.normalBalance === 'DEBIT' ? raw : safe(-raw, 'normal-balance normalization')
    const contribution = safe(normal * mapping.presentationSign, 'statement sign normalization')
    leafAmounts.set(target.id, add(leafAmounts.get(target.id) ?? 0, contribution, `${target.id} rollup`))
    mappedAccounts.push({ period: periodName, accountNumber: account.accountNumber, lineId: target.id, normalBalanceAmountCents: normal, statementAmountCents: contribution })
  }
  const income = rules.lines.filter(item => item.role === 'INCOME').reduce((sum, item) => add(sum, leafAmounts.get(item.id) ?? 0, 'income total'), 0)
  const expense = rules.lines.filter(item => item.role === 'EXPENSE').reduce((sum, item) => add(sum, leafAmounts.get(item.id) ?? 0, 'expense total'), 0)
  const netIncome = subtract(income, expense, 'net income')
  const values = new Map<string, number>()
  const calculate = (item: HgbStatementLineDefinition): number => {
    const cached = values.get(item.id); if (cached !== undefined) return cached
    let value = leafAmounts.get(item.id) ?? 0
    for (const child of rules.lines.filter(candidate => candidate.parentId === item.id)) value = add(value, calculate(child), `${item.id} hierarchy rollup`)
    if (item.derived === 'NET_INCOME') value = item.statement === 'BALANCE_SHEET' ? add(value, netIncome, `${item.id} net income`) : netIncome
    if (item.derived === 'GROSS_PROFIT') value = subtract(leafAmounts.get('IS.UKV.1') ?? 0, leafAmounts.get('IS.UKV.2') ?? 0, 'UKV gross profit')
    if (item.derived === 'PROFIT_AFTER_TAX') value = add(netIncome, leafAmounts.get(`IS.${rules.method}.TAX.OTHER`) ?? 0, 'profit after tax')
    values.set(item.id, value); return value
  }
  rules.lines.forEach(calculate)
  const assets = values.get('BS.ASSETS') ?? 0; const equityLiabilities = values.get('BS.EQUITY_LIABILITIES') ?? 0
  if (assets !== equityLiabilities) throw new HgbStatementValidationError([`${periodName} balance sheet differs by ${assets - equityLiabilities} cents after net-income transfer.`])
  const statementNet = values.get(rules.size === 'MICRO' ? 'IS.M.8' : `IS.${rules.method}.NET`)
  if (statementNet !== netIncome) throw new HgbStatementValidationError([`${periodName} income statement does not reconcile to net income.`])
  return { values, mappedAccounts, netIncome }
}

export function buildHgbStatements(input: HgbStatementInput): HgbStatementResult {
  const byId = validateRuleSet(input.ruleSet)
  validatePeriod(input.current, 'CURRENT'); validatePeriod(input.comparative, 'COMPARATIVE')
  if (input.comparative.endsAt >= input.current.startsAt) throw new HgbStatementValidationError(['The comparative period must end before the current period begins.'])
  for (const mapping of input.mappings) {
    if (!mapping.accountNumber?.trim() || !byId.has(mapping.lineId) || !validDate(mapping.effectiveFrom) || mapping.effectiveTo && (!validDate(mapping.effectiveTo) || mapping.effectiveTo < mapping.effectiveFrom)) throw new HgbStatementValidationError(['Every account mapping requires an account, registered line and valid effective date range.'])
  }
  const current = producePeriod(input.current, 'CURRENT', input.ruleSet, byId, input.mappings)
  const comparative = producePeriod(input.comparative, 'COMPARATIVE', input.ruleSet, byId, input.mappings)
  let expectedDifference = 0
  if (!Array.isArray(input.expectedComparativeLeaves)) throw new HgbStatementValidationError(['Approved prior-period comparative leaf values are required.'])
  const expected = new Map<string, number>()
  for (const item of input.expectedComparativeLeaves) {
    safe(item.amountCents, `expected comparative ${item.lineId}`)
    if (expected.has(item.lineId) || !byId.has(item.lineId) || input.ruleSet.lines.some(candidate => candidate.parentId === item.lineId)) throw new HgbStatementValidationError([`Expected comparative line ${item.lineId} is duplicate, unknown or not a leaf.`])
    expected.set(item.lineId, item.amountCents)
  }
  const leaves = input.ruleSet.lines.filter(item => !input.ruleSet.lines.some(candidate => candidate.parentId === item.id))
  for (const leaf of leaves) {
    if (!expected.has(leaf.id)) throw new HgbStatementValidationError([`Expected comparative leaf ${leaf.id} is missing.`])
    expectedDifference = add(expectedDifference, Math.abs(subtract(comparative.values.get(leaf.id) ?? 0, expected.get(leaf.id)!, 'comparative reconciliation')), 'comparative difference')
  }
  if (expectedDifference) throw new HgbStatementValidationError([`Comparative leaf values differ from the approved prior presentation by ${expectedDifference} cents.`])
  const lines = input.ruleSet.lines.map(item => {
    const amountCents = current.values.get(item.id) ?? 0; const comparativeAmountCents = comparative.values.get(item.id) ?? 0
    return { ...item, amountCents, comparativeAmountCents, changeCents: subtract(amountCents, comparativeAmountCents, `${item.id} comparative change`) }
  })
  return { ruleSetVersion: input.ruleSet.version, size: input.ruleSet.size, method: input.ruleSet.method, lines, mappedAccounts: [...current.mappedAccounts, ...comparative.mappedAccounts], currentNetIncomeCents: current.netIncome, comparativeNetIncomeCents: comparative.netIncome, checks: { currentTrialBalanceCents: 0, comparativeTrialBalanceCents: 0, currentBalanceSheetDifferenceCents: 0, comparativeBalanceSheetDifferenceCents: 0, currentIncomeStatementDifferenceCents: 0, comparativeIncomeStatementDifferenceCents: 0, comparativeExpectedDifferenceCents: 0 } }
}
