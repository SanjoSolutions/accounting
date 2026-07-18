export interface FiscalPeriod { id: string; ownerId: string; label: string; startsAt: string; endsAt: string; status?: 'OPEN' | 'CLOSED' | 'REOPENED' }
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const toDate = (value: string) => new Date(`${value}T00:00:00.000Z`)
const isRealDate = (value: string) => ISO_DATE.test(value) && !Number.isNaN(toDate(value).getTime()) && toDate(value).toISOString().slice(0, 10) === value
const nextDay = (value: string) => new Date(toDate(value).getTime() + 86_400_000).toISOString().slice(0, 10)

export function validateFiscalPeriods(periods: FiscalPeriod[], requireContinuity = true): string[] {
  const issues: string[] = []
  for (const ownerPeriods of Map.groupBy(periods, period => period.ownerId).values()) {
    const sorted = [...ownerPeriods].sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    const valid = sorted.filter(period => {
      if (!period.id || !isRealDate(period.startsAt) || !isRealDate(period.endsAt)) { issues.push('period requires stable id and real ISO dates'); return false }
      return true
    })
    valid.forEach((period, index) => {
      if (period.endsAt < period.startsAt) issues.push(`${period.id}: end precedes start`)
      const maxEnd = new Date(toDate(period.startsAt).getTime()); maxEnd.setUTCFullYear(maxEnd.getUTCFullYear() + 1); maxEnd.setUTCDate(maxEnd.getUTCDate() - 1)
      if (toDate(period.endsAt) > maxEnd) issues.push(`${period.id}: fiscal period exceeds twelve months`)
      const previous = valid[index - 1]
      if (previous && previous.endsAt >= period.startsAt) issues.push(`${period.id}: overlaps ${previous.id}`)
      if (requireContinuity && previous && nextDay(previous.endsAt) !== period.startsAt) issues.push(`${period.id}: gap after ${previous.id}`)
    })
  }
  return issues
}

export function periodForDate(periods: FiscalPeriod[], ownerId: string, bookingDate: string): FiscalPeriod {
  const matches = periods.filter(period => period.ownerId === ownerId && period.startsAt <= bookingDate && period.endsAt >= bookingDate)
  if (matches.length !== 1) throw new Error(matches.length ? 'Overlapping fiscal periods' : 'No fiscal period covers booking date')
  return matches[0]
}

export function createSuccessorPeriod(current: FiscalPeriod, id: string, label: string, endsAt: string): FiscalPeriod {
  const successor = { id, ownerId: current.ownerId, label, startsAt: nextDay(current.endsAt), endsAt, status: 'OPEN' as const }
  const issues = validateFiscalPeriods([current, successor])
  if (issues.length) throw new Error(issues.join('; '))
  return successor
}

export const periodDates = (period: FiscalPeriod) => ({ fiscalYearStart: period.startsAt, fiscalYearEnd: period.endsAt, balanceSheetDate: period.endsAt, openingDate: period.startsAt })
