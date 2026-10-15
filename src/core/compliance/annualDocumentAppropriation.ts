import type { AnnualPackageInput } from './annualAccounts'

/** Read-only presentation projection of the immutable contract published in #55.
 * Its producer validates the accounting calculation; the renderer never computes it.
 * Keep this adapter independent until that optional DTO is available on every source version.
 */
export interface RecordedAnnualAppropriation {
  annualResultCents: number
  shareCapitalCents: number
  priorLossCarryforwardCents: number
  priorProfitCarryforwardCents: number
  priorStatutoryReserveCents: number
  reserveAllocationCents: number
  distributionCents: number
  carryforwardCents: number
  resolutionEvidenceId: string
}

export function readRecordedAnnualAppropriation(input: AnnualPackageInput): RecordedAnnualAppropriation | undefined {
  const value: unknown = Reflect.get(input, 'ugResultAppropriation')
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value) || input.profile.legalForm !== 'UG') throw new Error('Invalid recorded UG result appropriation')
  const record = value as Record<string, unknown>
  const money = (key: keyof Omit<RecordedAnnualAppropriation, 'resolutionEvidenceId'>, nonnegative = true) => {
    const amount = record[key]
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || nonnegative && amount < 0) throw new Error(`Invalid recorded appropriation amount: ${key}`)
    return amount
  }
  const annualResultCents = money('annualResultCents', false)
  if (annualResultCents !== input.incomeStatement.find(line => line.code === 'NET_INCOME')?.amountCents) throw new Error('Recorded appropriation result differs from the approved income statement')
  if (typeof record.resolutionEvidenceId !== 'string' || !record.resolutionEvidenceId.trim()) throw new Error('Recorded appropriation resolution evidence is missing')
  return {
    annualResultCents, shareCapitalCents: money('shareCapitalCents'),
    priorLossCarryforwardCents: money('priorLossCarryforwardCents'), priorProfitCarryforwardCents: money('priorProfitCarryforwardCents'),
    priorStatutoryReserveCents: money('priorStatutoryReserveCents'), reserveAllocationCents: money('reserveAllocationCents'),
    distributionCents: money('distributionCents'), carryforwardCents: money('carryforwardCents', false),
    resolutionEvidenceId: record.resolutionEvidenceId,
  }
}
