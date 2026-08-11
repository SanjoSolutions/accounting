import { formatDisplayDateForLocale, formatDisplayDateTimeForLocale } from './dateFormatting'

const isoDateToken = /(?<![A-Za-z0-9_-])(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?)(?![A-Za-z0-9_-])/g

/** Localizes standalone ISO dates in human-facing API errors without touching IDs or machine tokens. */
export function localizeErrorDates(message: string, locale?: string): string {
  return message.replace(isoDateToken, value => value.includes('T')
    ? formatDisplayDateTimeForLocale(value, locale)
    : formatDisplayDateForLocale(value, locale))
}
