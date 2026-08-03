import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { HgbCloseWorkbench, initialHgbProfile, newHgbWorkpaper, profileIsExplicit } from './HgbCloseWorkbench'
import type { HgbCloseApi } from './hgbCloseClient'

describe('guided HGB close workbench', () => {
  it('fails closed until every scope and applicability fact is answered', () => {
    const profile = initialHgbProfile(2026)
    expect(profileIsExplicit(profile)).toBe(false)
    expect(profile.fiscalPeriodStart).toBe('2026-01-01')
    expect(profile.fiscalPeriodEnd).toBe('2026-12-31')
  })

  it('creates a typed schedule instead of an unstructured JSON workpaper', () => {
    expect(newHgbWorkpaper('CUT_OFF_AND_ACCRUAL_DEFERRAL')).toMatchObject({ kind: 'CUT_OFF_AND_ACCRUAL_DEFERRAL', schedule: { type: 'CUT_OFF_ACCRUAL_DEFERRAL', applicability: 'APPLICABLE', items: [] }, adjustments: [] })
    expect(newHgbWorkpaper('NOTES')).toMatchObject({ schedule: { type: 'NOTES_QUESTIONNAIRE', notesRequired: true, questions: [] } })
  })

  it('renders guided profile, schedule, approval and blocker sections without a raw JSON editor', () => {
    const api = {} as HgbCloseApi
    const markup = renderToStaticMarkup(createElement(HgbCloseWorkbench, { year: 2026, api }))
    expect(markup).toContain('Unternehmensprofil und Größenmerkmale')
    expect(markup).toContain('Arbeitspapiere und Bewertung')
    expect(markup).toContain('Unterschriften, Feststellung und Abschlusslauf')
    expect(markup).toContain('Nicht beantwortet')
    expect(markup).not.toContain('<textarea')
  })
})
