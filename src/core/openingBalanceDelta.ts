import { AccountingValidationError, MAX_DATABASE_CENTS, type OpeningBalanceLine } from './doubleEntry'

/** Append the difference from the carry-forwards already posted, per account. */
export function createOpeningBalanceDeltaLines(target: OpeningBalanceLine[], carried: OpeningBalanceLine[]): OpeningBalanceLine[] {
  const differences = new Map<string, number>()
  for (const [lines, sign] of [[target, 1], [carried, -1]] as const) {
    for (const line of lines) {
      differences.set(line.accountId, (differences.get(line.accountId) ?? 0) + sign * (line.debitCents - line.creditCents))
    }
  }
  if ([...differences.values()].reduce((sum, cents) => sum + cents, 0) !== 0) {
    throw new AccountingValidationError(['Der automatische Saldenvortrag ist nicht ausgeglichen.'])
  }
  const result: OpeningBalanceLine[] = []
  for (const [accountId, difference] of differences) {
    // A sign change can exceed one database Int even when each prior line fits.
    let remaining = Math.abs(difference)
    while (remaining > 0) {
      const cents = Math.min(remaining, MAX_DATABASE_CENTS)
      result.push({ accountId, debitCents: difference > 0 ? cents : 0, creditCents: difference < 0 ? cents : 0 })
      remaining -= cents
    }
  }
  return result
}
