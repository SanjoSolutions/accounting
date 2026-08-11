"use client"

import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  defaultFiscalYear,
  fiscalYearContextFromPath,
  fiscalYearHref,
  fiscalYearRange,
  type FiscalYearArea,
  type FiscalYearContext,
} from './fiscalYearRouting'

export { defaultFiscalYear, fiscalYearContextFromPath, fiscalYearHref, fiscalYearRange }
export type { FiscalYearArea, FiscalYearContext }

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
    {year > min ? <Link className="btn btn-outline-secondary year-step" href={fiscalYearHref(area, year - 1)} aria-label={t('previousFiscalYear', { year: year - 1 })}>← {year - 1}</Link> : <span className="btn btn-outline-secondary year-step disabled" aria-hidden="true">←</span>}
    <form onSubmit={openYear}>
      <label htmlFor={`${area}-year`}>{t('fiscalYear')}</label>
      <div className="input-group"><input className="form-control" id={`${area}-year`} type="number" min={min} max={max} required value={draftYear} onChange={event => setDraftYear(event.target.value)} /><button className="btn btn-outline-secondary" type="submit">{t('openFiscalYear')}</button></div>
    </form>
    {year < max ? <Link className="btn btn-outline-secondary year-step" href={fiscalYearHref(area, year + 1)} aria-label={t('nextFiscalYear', { year: year + 1 })}>{year + 1} →</Link> : <span className="btn btn-outline-secondary year-step disabled" aria-hidden="true">→</span>}
  </nav>
}
