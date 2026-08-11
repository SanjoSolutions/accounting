const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/

export type DisplayDateFormatter = (date: Date) => string

function parseDisplayDate(value: string): Date {
  const dateOnly = dateOnlyPattern.exec(value)
  if (!dateOnly) return new Date(value)

  const year = Number(dateOnly[1])
  const month = Number(dateOnly[2])
  const day = Number(dateOnly[3])
  const date = new Date(year, month - 1, day)

  // Date-only API values are calendar dates, so construct them in the browser's
  // local timezone instead of allowing UTC parsing to shift the displayed day.
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : new Date(Number.NaN)
}

function browserDisplayDateFormatter(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}

/** Formats an API date for display using the browser's locale while preserving invalid values. */
export function formatDisplayDate(value: string, formatter: DisplayDateFormatter = browserDisplayDateFormatter): string {
  const date = parseDisplayDate(value)
  return Number.isNaN(date.valueOf()) ? value : formatter(date)
}
