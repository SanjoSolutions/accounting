import 'server-only'

import type { CompliancePackage, Prisma } from '@/generated/prisma/client'
import { canonicalJson } from '@/core/compliance/auditExport'
import { GKV_ORDER, MICRO_BALANCE_SHEET_ORDER, SMALL_BALANCE_SHEET_ORDER, UKV_ORDER, type AnnualPackageInput } from '@/core/compliance/annualAccounts'
import { buildHgbStatements, createHgbStatementRuleSet, type HgbTrialBalanceAccount } from '@/core/hgbStatements'
import { hgbWorkpaperChecksum, validateHgbWorkpaper, type HgbWorkpaperDraft, type OpeningBalanceSchedule, type PolicyElectionsSchedule, type NotesQuestionnaireSchedule } from '@/core/hgbWorkpapers'
import { ComplianceRuntimeError } from './errors'
import { complianceReferenceDate } from './referenceDate'
import { closeEvidenceIds, loadVerifiedCloseEvidence } from './closeEvidence'
import { sha256 } from './retention'

type AuthoritativePeriod = { id: string; year: number; startsAt: Date; endsAt: Date }
const dateOnly = (value: Date) => value.toISOString().slice(0, 10)
function required(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new ComplianceRuntimeError(label + ' is required')
  return value.trim()
}

export async function assertCurrentAnnualPackage(client: Prisma.TransactionClient, record: Pick<CompliancePackage, 'ownerId' | 'fiscalPeriodId' | 'payload' | 'version' | 'supersedesId' | 'createdBy'>) {
  const envelope = JSON.parse(record.payload) as { sourceFingerprint?: unknown; version?: unknown; supersedesId?: unknown }
  if (typeof envelope.sourceFingerprint !== 'string' || envelope.version !== record.version || (envelope.supersedesId ?? null) !== (record.supersedesId ?? null)) throw new ComplianceRuntimeError('Annual accounts lack an exact source and version binding; prepare and approve a new package', 409)
  const period = await client.fiscalYear.findFirst({ where: { id: record.fiscalPeriodId ?? '', ownerId: record.ownerId } })
  if (!period) throw new ComplianceRuntimeError('Annual-account fiscal period not found', 409)
  const current = await loadAuthoritativeAnnualSource(client, record.ownerId, record.createdBy, period)
  if (current.sourceFingerprint !== envelope.sourceFingerprint) throw new ComplianceRuntimeError('Annual-account sources changed; prepare and approve a new package', 409)
}

export async function loadAuthoritativeAnnualSource(client: Prisma.TransactionClient, ownerId: string, actorId: string, period: AuthoritativePeriod) {
  const [profileVersion, previous] = await Promise.all([client.companyProfileVersion.findFirst({ where: { ownerId, effectiveFrom: { lte: period.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.endsAt } }] }, orderBy: { effectiveFrom: 'desc' } }), client.fiscalYear.findFirst({ where: { ownerId, endsAt: { lt: period.startsAt } }, orderBy: { endsAt: 'desc' }, include: { journalEntries: { where: { state: 'POSTED' }, include: { lines: { include: { account: true } } } } } })])
  if (!profileVersion || !previous) throw new ComplianceRuntimeError('Authoritative company profile and comparative fiscal period are required', 409)
  const current = await client.fiscalYear.findFirst({ where: { id: period.id, ownerId }, include: { journalEntries: { where: { state: 'POSTED' }, include: { lines: { include: { account: true } } } } } })
  if (!current) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  const profile = JSON.parse(profileVersion.payload) as Record<string, unknown>
  const chart = required(profile.chart, 'Authoritative company profile chart')
  const [mappings, records] = await Promise.all([
    client.accountMappingVersion.findMany({ where: { ownerId, chartId: chart, active: true, effectiveFrom: { lte: period.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: previous.startsAt } }] }, orderBy: [{ accountNumber: 'asc' }, { effectiveFrom: 'asc' }] }),
    client.hgbWorkpaperRecord.findMany({ where: { ownerId, fiscalPeriodId: period.id }, orderBy: [{ kind: 'asc' }, { version: 'desc' }] }),
  ])
  const latest = records.filter((item, index) => records.findIndex(candidate => candidate.kind === item.kind) === index)
  const reviewed = new Map<string, HgbWorkpaperDraft>()
  for (const item of latest.filter(item => item.status === 'REVIEWED')) {
    let payload: ReturnType<typeof validateHgbWorkpaper>
    try { payload = validateHgbWorkpaper(JSON.parse(item.payload) as HgbWorkpaperDraft, { startsAt: dateOnly(period.startsAt), endsAt: dateOnly(period.endsAt) }) } catch { throw new ComplianceRuntimeError(`The reviewed ${item.kind} workpaper is malformed`, 409) }
    if (hgbWorkpaperChecksum({ ownerId, fiscalPeriodId: period.id, kind: item.kind, payload }) !== item.checksum) throw new ComplianceRuntimeError(`The reviewed ${item.kind} workpaper checksum is invalid`, 409)
    reviewed.set(item.kind, payload)
  }
  const adjustments = latest.length ? await client.hgbAdjustmentRecord.findMany({ where: { ownerId, workpaperId: { in: latest.map(item => item.id) } } }) : []
  if (adjustments.some(item => item.status !== 'POSTED')) throw new ComplianceRuntimeError('Every reviewed workpaper adjustment must be posted before annual-account generation', 409)
  const requireWorkpaper = (kind: string) => { const workpaper = reviewed.get(kind); if (!workpaper) throw new ComplianceRuntimeError(`A current independently reviewed ${kind} workpaper is required`, 409); return workpaper }
  const sizeSchedule = requireWorkpaper('SIZE_AND_APPLICABILITY').schedule
  if (sizeSchedule.type !== 'SIZE_APPLICABILITY') throw new ComplianceRuntimeError('The reviewed size workpaper is malformed', 409)
  const size = sizeSchedule.establishedSize
  const policySchedule = requireWorkpaper('POLICY_ELECTIONS').schedule as PolicyElectionsSchedule
  const methods = policySchedule.elections.filter(item => item.applicable && item.selected && (item.policy === 'TOTAL_COST_PNL' || item.policy === 'FUNCTION_OF_EXPENSE_PNL'))
  if (methods.length !== 1) throw new ComplianceRuntimeError('Exactly one reviewed income-statement method election is required', 409)
  const method = methods[0].policy === 'TOTAL_COST_PNL' ? 'GKV' as const : 'UKV' as const
  if (size === 'MICRO' && method !== 'GKV') throw new ComplianceRuntimeError('The initial micro-entity annual-package adapter supports the condensed HGB § 275a layout with total-cost presentation only', 409)
  const opening = requireWorkpaper('OPENING_BALANCE').schedule as OpeningBalanceSchedule
  requireWorkpaper('MAPPING_AND_PRESENTATION'); requireWorkpaper('RECOGNITION_AND_OWNERSHIP'); requireWorkpaper('CUT_OFF_AND_ACCRUAL_DEFERRAL'); requireWorkpaper('PROVISIONS_AND_CONTINGENCIES'); requireWorkpaper('RECEIVABLE_AND_MARKET_VALUATION')
  const ruleSet = createHgbStatementRuleSet(size, method)
  const trialBalance = (year: typeof current): HgbTrialBalanceAccount[] => {
    const accounts = new Map<string, HgbTrialBalanceAccount>()
    for (const entry of year.journalEntries) for (const line of entry.lines) {
      const key = String(line.account.number); const value = accounts.get(key) ?? { accountNumber: key, openingDebitCents: 0, openingCreditCents: 0, debitCents: 0, creditCents: 0 }
      value.debitCents += line.debitCents; value.creditCents += line.creditCents
      if (!Number.isSafeInteger(value.debitCents) || !Number.isSafeInteger(value.creditCents)) throw new ComplianceRuntimeError(`Trial balance arithmetic is unsafe for account ${key}`, 409)
      accounts.set(key, value)
    }
    return [...accounts.values()].sort((left, right) => left.accountNumber.localeCompare(right.accountNumber))
  }
  const statement = buildHgbStatements({
    ruleSet,
    current: { startsAt: dateOnly(current.startsAt), endsAt: dateOnly(current.endsAt), accounts: trialBalance(current) },
    comparative: { startsAt: dateOnly(previous.startsAt), endsAt: dateOnly(previous.endsAt), accounts: trialBalance(previous as typeof current) },
    mappings: mappings.map(mapping => ({ accountNumber: String(mapping.accountNumber), lineId: mapping.hgbPosition, normalBalance: mapping.normalBalance as 'DEBIT' | 'CREDIT', presentationSign: mapping.presentationSign as 1 | -1, effectiveFrom: dateOnly(mapping.effectiveFrom), ...(mapping.effectiveTo ? { effectiveTo: dateOnly(mapping.effectiveTo) } : {}) })),
    expectedComparativeLeaves: opening.approvedComparativeLeaves,
  })
  const accountIds = new Map<number, string>(); for (const year of [current, previous as typeof current]) for (const entry of year.journalEntries) for (const line of entry.lines) accountIds.set(line.account.number, line.accountId)
  const byId = new Map(statement.lines.map(line => [line.id, line]))
  const sourceAccounts = (lineId: string) => statement.mappedAccounts.filter(item => item.lineId === lineId).map(item => accountIds.get(Number(item.accountNumber))).filter((id): id is string => Boolean(id))
  const convert = (codes: readonly string[], map: Record<string, string>) => codes.map(code => { const line = byId.get(map[code]); const sign = line?.role === 'EXPENSE' ? -1 : 1; return { code, label: line?.label ?? code, amountCents: (line?.amountCents ?? 0) * sign, comparativeCents: (line?.comparativeAmountCents ?? 0) * sign, accountIds: line ? [...new Set(sourceAccounts(line.id))] : [] } })
  const balanceMap = hgbAnnualBalanceMap()
  const incomeMap = hgbAnnualIncomeMap(size, method)
  const balanceCodes = size === 'MICRO' ? MICRO_BALANCE_SHEET_ORDER : SMALL_BALANCE_SHEET_ORDER
  const incomeCodes = method === 'GKV' ? GKV_ORDER.filter(code => code !== 'GROSS_PROFIT') : UKV_ORDER
  const notesWorkpaper = reviewed.get('NOTES')?.schedule as NotesQuestionnaireSchedule | undefined
  const notes = notesWorkpaper?.type === 'NOTES_QUESTIONNAIRE' && Array.isArray(notesWorkpaper.questions) ? notesWorkpaper.questions.filter(item => item.answer === 'YES' && item.disclosureText?.trim()).map(item => item.disclosureText!.trim()) : ['Anhangangaben werden aufgrund der dokumentierten Kleinstkapitalgesellschaft-Erleichterung unter der Bilanz ausgewiesen.']
  const annualInput: AnnualPackageInput = { profile: { tenantId: ownerId, legalName: String(profile.companyName ?? ''), legalForm: String(profile.legalForm ?? ''), registerCourt: String(profile.registerCourt ?? ''), registerNumber: String(profile.registerNumber ?? ''), registeredOffice: String((profile.registeredAddress as Record<string, unknown> | undefined)?.city ?? ''), size, currency: 'EUR', language: 'de' }, fiscalYear: period.year, previousFiscalYear: previous.year, previousFiscalPeriodStart: dateOnly(previous.startsAt), previousFiscalPeriodEnd: dateOnly(previous.endsAt), previousFiscalPeriodId: previous.id, fiscalPeriodStart: dateOnly(period.startsAt), fiscalPeriodEnd: dateOnly(period.endsAt), fiscalTimeZone: 'Europe/Berlin', method, balanceSheet: convert(balanceCodes, balanceMap), incomeStatement: convert(incomeCodes, incomeMap), policies: policySchedule.elections.filter(item => item.applicable && item.selected).map(item => `${item.policy}: ${item.rationale.trim()}`), notes, checks: { nonOffsetting: true, accrual: true, provisions: true, valuation: true, continuity: true }, preparedBy: actorId, preparedAt: `${complianceReferenceDate()}T12:00:00.000Z` }
  const { evidence, missingEvidenceIds } = await loadVerifiedCloseEvidence(client, ownerId, closeEvidenceIds(latest.map(item => JSON.parse(item.payload))))
  if (missingEvidenceIds.length) throw new ComplianceRuntimeError('Annual-account evidence is missing, unreadable, or failed fixity verification', 409)
  const yearSource = (year: typeof current) => ({ id: year.id, startsAt: year.startsAt, endsAt: year.endsAt, journalEntries: [...year.journalEntries].sort((a, b) => a.id.localeCompare(b.id)).map(entry => ({ ...entry, lines: [...entry.lines].sort((a, b) => a.id.localeCompare(b.id)) })) })
  const bySourceId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => a.id.localeCompare(b.id))
  const sourceFingerprint = sha256(canonicalJson({ profileVersion, current: yearSource(current), previous: yearSource(previous as typeof current), mappings: bySourceId(mappings), workpapers: bySourceId(latest), adjustments: bySourceId(adjustments), evidence }))
  return { annualInput, sourceFingerprint }
}

function hgbAnnualBalanceMap(): Record<string, string> {
  return { 'A.ASSETS': 'BS.ASSETS', 'A.FIXED': 'BS.A.A', 'A.INTANGIBLE': 'BS.A.A.I', 'A.TANGIBLE': 'BS.A.A.II', 'A.FINANCIAL': 'BS.A.A.III', 'A.CURRENT': 'BS.A.B', 'A.INVENTORIES': 'BS.A.B.I', 'A.RECEIVABLES': 'BS.A.B.II', 'A.SECURITIES': 'BS.A.B.III', 'A.CASH': 'BS.A.B.IV', 'A.PREPAID': 'BS.A.C', 'A.DEFERRED_TAX': 'BS.A.D', 'A.PENSION_DIFFERENCE': 'BS.A.E', 'B.EQUITY_LIABILITIES': 'BS.EQUITY_LIABILITIES', 'B.EQUITY': 'BS.P.A', 'B.SUBSCRIBED_CAPITAL': 'BS.P.A.I', 'B.CAPITAL_RESERVE': 'BS.P.A.II', 'B.REVENUE_RESERVES': 'BS.P.A.III', 'B.CARRYFORWARD': 'BS.P.A.IV', 'B.NET_INCOME': 'BS.P.A.V', 'B.PROVISIONS': 'BS.P.B', 'B.LIABILITIES': 'BS.P.C', 'B.DEFERRED': 'BS.P.D', 'B.DEFERRED_TAX': 'BS.P.E' }
}

function hgbAnnualIncomeMap(size: 'MICRO' | 'SMALL', method: 'GKV' | 'UKV'): Record<string, string> {
  if (size === 'MICRO') return { REVENUE: 'IS.M.1', OTHER_INCOME: 'IS.M.2', MATERIAL_RAW: 'IS.M.3', PERSONNEL_WAGES: 'IS.M.4', DEPRECIATION_FIXED: 'IS.M.5', OTHER_EXPENSE: 'IS.M.6', INCOME_TAX: 'IS.M.7', RESULT_AFTER_TAX: 'IS.M.8', NET_INCOME: 'IS.M.8' }
  const prefix = `IS.${method}`
  return method === 'GKV'
    ? { REVENUE: 'IS.GKV.1', INVENTORY_CHANGE: 'IS.GKV.2', OWN_WORK: 'IS.GKV.3', OTHER_INCOME: 'IS.GKV.4', MATERIAL_RAW: 'IS.GKV.5.A', MATERIAL_SERVICES: 'IS.GKV.5.B', PERSONNEL_WAGES: 'IS.GKV.6.A', PERSONNEL_SOCIAL: 'IS.GKV.6.B', DEPRECIATION_FIXED: 'IS.GKV.7.A', DEPRECIATION_CURRENT: 'IS.GKV.7.B', OTHER_EXPENSE: 'IS.GKV.8', PARTICIPATION_INCOME: `${prefix}.FIN.1`, AFFILIATED_INCOME: `${prefix}.FIN.2`, INTEREST_INCOME: `${prefix}.FIN.3`, FINANCIAL_DEPRECIATION: `${prefix}.FIN.4`, INTEREST_EXPENSE: `${prefix}.FIN.5`, INCOME_TAX: `${prefix}.TAX.INCOME`, RESULT_AFTER_TAX: `${prefix}.AFTER_TAX`, OTHER_TAX: `${prefix}.TAX.OTHER`, NET_INCOME: `${prefix}.NET` }
    : { REVENUE: 'IS.UKV.1', COST_OF_SALES: 'IS.UKV.2', GROSS_SALES_PROFIT: 'IS.UKV.3', DISTRIBUTION: 'IS.UKV.4', ADMINISTRATION: 'IS.UKV.5', OTHER_INCOME: 'IS.UKV.6', OTHER_EXPENSE: 'IS.UKV.7', PARTICIPATION_INCOME: `${prefix}.FIN.1`, AFFILIATED_INCOME: `${prefix}.FIN.2`, INTEREST_INCOME: `${prefix}.FIN.3`, FINANCIAL_DEPRECIATION: `${prefix}.FIN.4`, INTEREST_EXPENSE: `${prefix}.FIN.5`, INCOME_TAX: `${prefix}.TAX.INCOME`, RESULT_AFTER_TAX: `${prefix}.AFTER_TAX`, OTHER_TAX: `${prefix}.TAX.OTHER`, NET_INCOME: `${prefix}.NET` }
}
