import { AccountingValidationError, type PostingLineInput } from '@/core/doubleEntry'
import { calculateMixedVat, restoreVatPosting, type VatPostingDetail, type VatSourceSplit } from '@/core/vatEngine'
import type { Prisma } from '@/generated/prisma/client'
import { germanVatRuleBook, journalLineVatData, vatControlAccount, vatPostingCreateData, type VatReversalContext } from './vatPostingCalculation'

type OriginalLine = Prisma.JournalLineGetPayload<{ include: { vatPosting: true } }>
export type CorrectionLine = PostingLineInput & { id: string; originalVat?: OriginalLine['vatPosting'] }
type Account = { id: string; number: number; category: string; eBilanzPosition: string | null }

export function persistedVatSpecification(posting: { source: string } | null | undefined): PostingLineInput['vat'] {
  if (!posting) return undefined
  const detail = JSON.parse(posting.source) as VatPostingDetail
  return { ruleId: detail.ruleId, mode: detail.mode, direction: detail.direction ?? 'sale' }
}

/** Bind each reversal line to one exact original; request data cannot invent a VAT reversal. */
export function bindCorrectionReversal(lines: CorrectionLine[], originals: OriginalLine[]) {
  const remaining = [...originals]
  for (const line of lines) {
    const index = remaining.findIndex(original => original.accountId === line.accountId
      && original.debitCents === line.creditCents && original.creditCents === line.debitCents
      && (original.taxCode || null) === (line.taxCode || null))
    if (index < 0) throw new AccountingValidationError(['Das Storno muss die ursprünglichen Buchungszeilen exakt umkehren.'])
    const original = remaining.splice(index, 1)[0]
    if (!original.vatPosting && [original.taxCode, original.taxPoint, original.taxRuleId, original.taxRuleVersion, original.netBaseCents, original.taxAmountCents, original.taxRateBasisPoints, original.deductibleTaxCents, original.taxJurisdiction, original.taxReason].some(value => value != null && value !== '')) {
      throw new AccountingValidationError(['Die steuerpflichtige Originalbuchung besitzt keinen vollständig verknüpften Umsatzsteuernachweis.'])
    }
    if (original.vatPosting) {
      const detail = JSON.parse(original.vatPosting.source) as VatPostingDetail
      const sameValue = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)
      const lineData = journalLineVatData(detail)
      const { source: _source, ...recordData } = vatPostingCreateData(detail.ownerId, original.id, detail, original.vatPosting.documentId ?? undefined)
      if (Object.entries(lineData).some(([key, value]) => !sameValue(original[key as keyof OriginalLine], value))
        || Object.entries(recordData).some(([key, value]) => !sameValue(original.vatPosting![key as keyof typeof recordData], value))) {
        throw new AccountingValidationError(['Die Originalzeile und ihr Umsatzsteuernachweis stimmen nicht überein.'])
      }
    }
    line.originalVat = original.vatPosting
    line.vat = persistedVatSpecification(original.vatPosting)
  }
  if (remaining.length) throw new AccountingValidationError(['Das Storno muss alle ursprünglichen Buchungszeilen umkehren.'])
}

export function calculateCorrectionVat(ownerId: string, entryId: string, bookingDate: string, lines: CorrectionLine[], context: VatReversalContext) {
  const originals: VatPostingDetail[] = []
  const splits: VatSourceSplit[] = []
  for (const line of lines) {
    if (line.taxCode && !line.vat) throw new AccountingValidationError(['Ein Steuerschlüssel ohne berechenbaren Umsatzsteuernachweis wird nicht unterstützt.'])
    if (!line.vat) continue
    const sourceId = `journal:${entryId}:line:${line.id}`
    if (line.originalVat) {
      const row = line.originalVat
      const original = restoreVatPosting(JSON.parse(row.source) as VatPostingDetail, germanVatRuleBook, context.registry)
      if (original.ownerId !== ownerId || original.sourceId !== row.sourceId || original.reversalOf) throw new AccountingValidationError(['Der Umsatzsteuernachweis gehört nicht zum unveränderten Original.'])
      originals.push(original)
      if (original.taxPoint.slice(0, 7) !== bookingDate.slice(0, 7)) throw new AccountingValidationError(['Das Originalstorno muss in der ursprünglichen Umsatzsteuerperiode liegen.'])
      splits.push({ ...original, sourceId, taxPoint: original.taxPoint, reversalOf: original.sourceId, originalTaxPoint: original.taxPoint })
    } else {
      splits.push({ ownerId, sourceId, amountCents: Math.abs(line.debitCents - line.creditCents), taxPoint: bookingDate, ...line.vat })
    }
  }
  return calculateMixedVat(splits, germanVatRuleBook, originals, context.registry)
}

/** Corrections must explain every tax control amount, including zero/cancelled totals. */
export function validateCorrectionVat(details: readonly VatPostingDetail[], lines: CorrectionLine[], accounts: Account[], accountLength: number) {
  const bySource = new Map(details.map(detail => [detail.sourceId.split(':').at(-1)!, detail]))
  const scale = 10 ** (accountLength - 4)
  const outputNumbers = new Set(germanVatRuleBook.rules.map(rule => Number(rule.outputAccount) * scale))
  const inputNumbers = new Set(germanVatRuleBook.rules.flatMap(rule => rule.inputAccount ? [Number(rule.inputAccount) * scale] : []))
  const expected = new Map<number, number>()
  for (const detail of details) {
    for (const [direction, cents] of [['output', detail.outputTaxCents], ['input', -detail.inputTaxCents]] as const) {
      if (!cents) continue
      const number = Number(vatControlAccount(detail, direction)) * scale
      expected.set(number, (expected.get(number) ?? 0) + cents)
    }
  }
  for (const line of lines) {
    const detail = bySource.get(line.id)
    if (!detail) continue
    const account = accounts.find(account => account.id === line.accountId)!
    const purchase = detail.direction === 'purchase'
    const base = purchase ? line.debitCents - line.creditCents : line.creditCents - line.debitCents
    if (base !== detail.netBaseCents || (purchase ? !['EXPENSE', 'ASSET'].includes(account.category) : account.category !== 'REVENUE')) {
      throw new AccountingValidationError(['Der Umsatzsteuernachweis muss Richtung und Nettobetrag der Buchungszeile exakt erklären.'])
    }
  }
  for (const account of accounts) {
    const isControl = expected.has(account.number)
      || account.eBilanzPosition === 'bs.eqLiab.liab.other.theroffTax.vat'
      || account.eBilanzPosition === 'bs.ass.currAss.receiv.other.vat'
      || (account.category === 'LIABILITY' && outputNumbers.has(account.number))
      || (account.category === 'ASSET' && inputNumbers.has(account.number))
    if (!isControl) continue
    const actual = lines.filter(line => line.accountId === account.id).reduce((sum, line) => sum + line.creditCents - line.debitCents, 0)
    if (actual !== (expected.get(account.number) ?? 0)) throw new AccountingValidationError([`Das Steuerkonto ${account.number} stimmt nicht mit dem Umsatzsteuernachweis überein.`])
    expected.delete(account.number)
  }
  if ([...expected.values()].some(cents => cents !== 0)) throw new AccountingValidationError(['Ein benötigtes Steuerkonto fehlt in der Korrekturbuchung.'])
}
