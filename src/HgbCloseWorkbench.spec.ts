import { describe, expect, test, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { evaluationInput, HgbCloseWorkbench, initialHgbProfile, newHgbWorkpaper, profileIsExplicit, reloadedHgbDraft, savedHgbProfile, structuredItemTemplate } from './HgbCloseWorkbench'
import type { HgbCloseApi, HgbWorkpaperCollection } from './hgbCloseClient'
import { canSaveReviewPolicy, initialReviewPolicyChoice } from './HgbReviewPolicyPanel'

vi.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: (namespace: string) => {
    const source = JSON.parse(readFileSync('messages/en.json', 'utf8')) as Record<string, unknown>
    const values = source[namespace] as Record<string, unknown>
    const resolve = (key: string): string => key.split('.').reduce<unknown>((value, part) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined), values) as string ?? key
    return (key: string, replacements: Record<string, string | number> = {}) => Object.entries(replacements).reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), resolve(key))
  },
}))

describe('guided HGB close workbench', () => {
  test('Given selected equity work, when a mutation refreshes the collection, then the editor retains that kind and hydrates its own saved content', () => {
    const current = newHgbWorkpaper('GMBH_EQUITY_AND_RESULT', 2026)
    const equity = { ...current, title: 'Reviewed UG equity' }
    const size = newHgbWorkpaper('SIZE_AND_APPLICABILITY', 2026)
    const collection = { workpapers: [{ kind: size.kind, payload: size }, { kind: equity.kind, payload: equity }] } as HgbWorkpaperCollection
    const reloaded = reloadedHgbDraft(current, collection)
    expect(reloaded).toEqual(equity)
    reloaded.title = 'Next draft'
    expect(equity.title).toBe('Reviewed UG equity')
    expect(reloadedHgbDraft(current, { workpapers: [] } as unknown as HgbWorkpaperCollection)).toEqual(current)
  })
  test('Given a persisted owner policy, when the form opens, then it preserves the selection and requires a meaningful change before saving', () => {
    const policy = { mode: 'OWNER_SELF_REVIEW' as const, reason: 'Owner evidence checked', evidenceIds: ['register', 'articles'], soleShareholderManagingDirector: true, noAdditionalReviewRequirement: true }
    const choice = initialReviewPolicyChoice(policy)
    expect(choice.mode).toBe('OWNER_SELF_REVIEW')
    expect(canSaveReviewPolicy(choice, policy)).toBe(false)
    expect(canSaveReviewPolicy({ ...choice, reason: ` ${choice.reason} `, evidenceIds: ['articles', 'register', 'register'] }, policy)).toBe(false)
    expect(canSaveReviewPolicy({ ...choice, reason: 'New evidence checked' }, policy)).toBe(true)
    expect(canSaveReviewPolicy(choice, policy, false)).toBe(true)
    expect(canSaveReviewPolicy({ ...choice, reason: '' }, policy, false)).toBe(false)
    choice.evidenceIds.push('new')
    expect(policy.evidenceIds).toHaveLength(2)
  })
  test('Given retained size facts, when reopening the workbench, then the editable profile preserves those facts without mutating the retained record', () => {
    const draft = newHgbWorkpaper('SIZE_AND_APPLICABILITY', 2026)
    const collection = { workpapers: [{ kind: draft.kind, payload: draft }] } as HgbWorkpaperCollection
    const restored = savedHgbProfile(collection)!
    expect(restored.fiscalPeriodStart).toBe('2026-01-01')
    restored.legalForm = 'UG'
    expect(savedHgbProfile(collection)?.legalForm).toBe('')
  })
  test('fails closed until every scope and applicability fact is answered', () => {
    const profile = initialHgbProfile(2026)
    expect(profileIsExplicit(profile)).toBe(false)
    expect(profile.fiscalPeriodStart).toBe('2026-01-01')
    expect(profile.fiscalPeriodEnd).toBe('2026-12-31')
  })

  test('creates a typed schedule instead of an unstructured JSON workpaper', () => {
    expect(newHgbWorkpaper('CUT_OFF_AND_ACCRUAL_DEFERRAL')).toMatchObject({ kind: 'CUT_OFF_AND_ACCRUAL_DEFERRAL', schedule: { type: 'CUT_OFF_ACCRUAL_DEFERRAL', applicability: 'APPLICABLE', items: [] }, adjustments: [] })
    expect(newHgbWorkpaper('NOTES')).toMatchObject({ schedule: { type: 'NOTES_QUESTIONNAIRE', notesRequired: true, questions: [] } })
  })

  test('uses the generic comparative-leaf template when adding every subsequent row', () => {
    expect(structuredItemTemplate('approvedComparativeLeaves', 'OPENING_BALANCE')).toEqual({ lineId: '', amountCents: 0 })
  })

  test('renders localized guided profile, schema labels and approval sections without a raw JSON editor', () => {
    const api = {} as HgbCloseApi
    const markup = renderToStaticMarkup(createElement(HgbCloseWorkbench, { year: 2026, api }))
    expect(markup).toContain('Company profile and size facts')
    expect(markup).toContain('Workpapers and assessment')
    expect(markup).toContain('Signatures, annual-accounts adoption and close run')
    expect(markup).toContain('Approved annual accounts')
    expect(markup).toContain('Not answered')
    expect(markup).toContain('data-field-key="schedule"')
    expect(markup).toContain('data-field-key="legalForm"')
    expect(markup).toContain('value="UNKNOWN"')
    expect(markup).toContain('Unknown</option>')
    expect(markup).toContain('Applicable</option>')
    expect(markup).not.toContain('fields.')
    expect(markup).not.toContain('enum.')
    expect(markup).not.toContain('<textarea')
  })

  test('binds the selected approved annual package and its checksum into the close request', () => {
    expect(evaluationInput('director-1', 'signature-1', '2027-01-15T11:00', 'resolution-1', 'Final review', { id: 'annual-1', checksum: 'a'.repeat(64) })).toMatchObject({
      annualAccountsPackageId: 'annual-1', annualAccountsChecksum: 'a'.repeat(64), legalRepresentativeIds: ['director-1'], shareholderResolutionId: 'resolution-1',
      managingDirectorSignatures: [{ representativeId: 'director-1', signatureEvidenceId: 'signature-1', signedAt: expect.stringMatching(/^2027-01-15T\d{2}:00:00\.000Z$/) }],
    })
  })
})
