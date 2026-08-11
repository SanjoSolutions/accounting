const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/

export type DisplayDateFormatter = (date: Date) => string

export const displayDateOptions: Intl.DateTimeFormatOptions = { dateStyle: 'medium' }
export const displayDateTimeOptions: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' }

/** Parses a date-only API value as a local calendar date, avoiding UTC day shifts. */
export function parseDisplayDate(value: string): Date {
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

function browserDisplayDateFormatter(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, displayDateOptions).format(date)
}

function browserDisplayDateTimeFormatter(date: Date, locale?: string): string {
  return new Intl.DateTimeFormat(locale, displayDateTimeOptions).format(date)
}

/** Formats an API date for display using the browser's locale while preserving invalid values. */
export function formatDisplayDate(value: string, formatter: DisplayDateFormatter = browserDisplayDateFormatter): string {
  const date = parseDisplayDate(value)
  return Number.isNaN(date.valueOf()) ? value : formatter(date)
}

/** Formats with an explicit regional locale while keeping date-only values local-calendar-safe. */
export function formatDisplayDateForLocale(value: string, locale?: string): string {
  return formatDisplayDate(value, date => browserDisplayDateFormatter(date, locale))
}

/** Formats an API instant for display using the browser's locale and time zone. */
export function formatDisplayDateTime(value: string, formatter: DisplayDateFormatter = browserDisplayDateTimeFormatter): string {
  const date = parseDisplayDate(value)
  return Number.isNaN(date.valueOf()) ? value : formatter(date)
}

/** Formats an instant with an explicit regional locale and the browser time zone. */
export function formatDisplayDateTimeForLocale(value: string, locale?: string): string {
  return formatDisplayDateTime(value, date => browserDisplayDateTimeFormatter(date, locale))
}

/** Escapes JSON for safe insertion into an inline script. */
export function serializeInlineScriptValue(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}
