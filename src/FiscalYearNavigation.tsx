"use client"

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

export type FiscalYearArea = 'annual-close' | 'e-bilanz' | 'tax'

const ranges: Record<FiscalYearArea, { min: number; max: number }> = {
  'annual-close': { min: 1900, max: 2200 },
  'e-bilanz': { min: 2025, max: 2026 },
  'tax': { min: 2025, max: 2026 },
}

export function fiscalYearRange(area: FiscalYearArea) { return ranges[area] }
export function defaultFiscalYear(area: FiscalYearArea, currentYear: number) {
  const { min, max } = fiscalYearRange(area)
  return Math.min(max, Math.max(min, currentYear))
}

export function fiscalYearHref(area: FiscalYearArea, year: number) {
  const { min, max } = fiscalYearRange(area)
  if (!Number.isInteger(year) || year < min || year > max) throw new Error('Invalid fiscal year')
  return `/${area}/${year}`
}

export function FiscalYearNavigation({ area, year }: { area: FiscalYearArea; year: number }) {
  const t = useTranslations('Workspaces')
  const router = useRouter()
  const { min, max } = fiscalYearRange(area)
  const [draftYear, setDraftYear] = useState(String(year))
  useEffect(() => setDraftYear(String(year)), [year])

  function openYear(event: FormEvent) {
    event.preventDefault()
    const selectedYear = Number(draftYear)
    if (Number.isInteger(selectedYear) && selectedYear >= min && selectedYear <= max) router.push(fiscalYearHref(area, selectedYear))
  }

  return <nav className="fiscal-year-navigation" aria-label={t('fiscalYearNavigation')}>
    {year > min ? <Link className="year-step" href={fiscalYearHref(area, year - 1)} aria-label={t('previousFiscalYear', { year: year - 1 })}>← {year - 1}</Link> : <span className="year-step disabled" aria-hidden="true">←</span>}
    <form onSubmit={openYear}>
      <label htmlFor={`${area}-year`}>{t('fiscalYear')}</label>
      <div><input id={`${area}-year`} type="number" min={min} max={max} required value={draftYear} onChange={event => setDraftYear(event.target.value)} /><button type="submit">{t('openFiscalYear')}</button></div>
    </form>
    {year < max ? <Link className="year-step" href={fiscalYearHref(area, year + 1)} aria-label={t('nextFiscalYear', { year: year + 1 })}>{year + 1} →</Link> : <span className="year-step disabled" aria-hidden="true">→</span>}
  </nav>
}
