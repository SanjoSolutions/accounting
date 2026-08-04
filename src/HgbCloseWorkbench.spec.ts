import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { evaluationInput, HgbCloseWorkbench, initialHgbProfile, newHgbWorkpaper, profileIsExplicit, structuredItemTemplate } from './HgbCloseWorkbench'
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

  it('uses the generic comparative-leaf template when adding every subsequent row', () => {
    expect(structuredItemTemplate('approvedComparativeLeaves', 'OPENING_BALANCE')).toEqual({ lineId: '', amountCents: 0 })
  })

  it('renders guided profile, schedule, approval and blocker sections without a raw JSON editor', () => {
    const api = {} as HgbCloseApi
    const markup = renderToStaticMarkup(createElement(HgbCloseWorkbench, { year: 2026, api }))
    expect(markup).toContain('Unternehmensprofil und Größenmerkmale')
    expect(markup).toContain('Arbeitspapiere und Bewertung')
    expect(markup).toContain('Unterschriften, Feststellung und Abschlusslauf')
    expect(markup).toContain('Freigegebener Jahresabschluss')
    expect(markup).toContain('Nicht beantwortet')
    expect(markup).toContain('data-field-key="schedule"')
    expect(markup).toContain('data-field-key="legalForm"')
    expect(markup).not.toContain('<textarea')
  })

  it('binds the selected approved annual package and its checksum into the close request', () => {
    expect(evaluationInput('director-1', 'signature-1', '2027-01-15T11:00', 'resolution-1', 'Final review', { id: 'annual-1', checksum: 'a'.repeat(64) })).toMatchObject({
      annualAccountsPackageId: 'annual-1', annualAccountsChecksum: 'a'.repeat(64), legalRepresentativeIds: ['director-1'], shareholderResolutionId: 'resolution-1',
      managingDirectorSignatures: [{ representativeId: 'director-1', signatureEvidenceId: 'signature-1', signedAt: expect.stringMatching(/^2027-01-15T\d{2}:00:00\.000Z$/) }],
    })
  })
})
