export type FiscalYearArea = 'annual-close' | 'e-bilanz' | 'tax' | 'reports' | 'dashboard' | 'bookings' | 'booking-batches' | 'journal'

export type FiscalYearContext = { area: FiscalYearArea; year: number }

const ranges: Record<FiscalYearArea, { min: number; max: number }> = {
  'annual-close': { min: 1900, max: 2200 },
  'e-bilanz': { min: 2025, max: 2026 },
  'tax': { min: 2025, max: 2026 },
  'reports': { min: 1900, max: 2200 },
  dashboard: { min: 1900, max: 2200 },
  bookings: { min: 1900, max: 2200 },
  'booking-batches': { min: 1900, max: 2200 },
  journal: { min: 1900, max: 2200 },
}

export function fiscalYearRange(area: FiscalYearArea) { return ranges[area] }

export function defaultFiscalYear(area: FiscalYearArea, currentYear: number) {
  const { min, max } = fiscalYearRange(area)
  return Math.min(max, Math.max(min, currentYear))
}

export function isFiscalYearSearchParameter(value: string | string[] | undefined | null): value is string {
  return typeof value === 'string' && /^\d{4}$/.test(value) && Number(value) >= 1900 && Number(value) <= 2200
}

export function fiscalYearFromSearchParameter(value: string | string[] | undefined | null, currentYear = new Date().getFullYear()) {
  return isFiscalYearSearchParameter(value) ? Number(value) : defaultFiscalYear('dashboard', currentYear)
}

export function fiscalYearHref(area: FiscalYearArea, year: number) {
  const { min, max } = fiscalYearRange(area)
  if (!Number.isInteger(year) || year < min || year > max) throw new Error('Invalid fiscal year')
  if (area === 'dashboard') return `/?year=${year}`
  if (area === 'bookings' || area === 'booking-batches' || area === 'journal') return `/${area}?year=${year}`
  return `/${area}/${year}`
}

/** Resolve the fiscal-year workspace represented by the current URL. */
export function fiscalYearContextFromPath(
  pathname: string,
  yearSearchParameter?: string | null,
  currentYear = new Date().getFullYear(),
): FiscalYearContext | null {
  const normalizedPath = pathname.replace(/\/+$/, '') || '/'
  const queryArea: Record<string, FiscalYearArea> = {
    '/': 'dashboard',
    '/bookings': 'bookings',
    '/booking-batches': 'booking-batches',
    '/journal': 'journal',
  }
  const areaFromQuery = queryArea[normalizedPath]
  if (areaFromQuery) return { area: areaFromQuery, year: fiscalYearFromSearchParameter(yearSearchParameter, currentYear) }

  const match = normalizedPath.match(/^\/(annual-close|e-bilanz|tax|reports)\/(\d{4})(?:\/|$)/)
  if (!match) return null

  const area = match[1] as FiscalYearArea
  const year = Number(match[2])
  const { min, max } = fiscalYearRange(area)
  return Number.isInteger(year) && year >= min && year <= max ? { area, year } : null
}
