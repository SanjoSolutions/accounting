'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { validateHgbReviewPolicyChoice, type HgbReviewPolicyChoice } from './core/hgbReviewPolicy'
import type { HgbCloseApi, HgbWorkpaperCollection } from './hgbCloseClient'

export function initialReviewPolicyChoice(policy?: HgbReviewPolicyChoice | null): HgbReviewPolicyChoice {
  return policy ? structuredClone(validateHgbReviewPolicyChoice(policy)) : { mode: 'INDEPENDENT', reason: '', evidenceIds: [], soleShareholderManagingDirector: false, noAdditionalReviewRequirement: false }
}

export function canSaveReviewPolicy(choice: HgbReviewPolicyChoice, policy?: HgbReviewPolicyChoice | null, valid = true) {
  try {
    const normalized = validateHgbReviewPolicyChoice(choice)
    return !policy || !valid || JSON.stringify(normalized) !== JSON.stringify(validateHgbReviewPolicyChoice(policy))
  } catch { return false }
}

export function HgbReviewPolicyPanel({ year, tenantId, collection, api, busy, perform }: { year: number; tenantId?: string; collection?: HgbWorkpaperCollection; api: HgbCloseApi; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useTranslations('HgbReviewPolicy'); const locale = useLocale()
  const policy = collection?.reviewPolicy
  const [choice, setChoice] = useState(() => initialReviewPolicyChoice(policy))
  const self = choice.mode === 'OWNER_SELF_REVIEW'
  const scopePrepared = collection?.workpapers.some(record => record.kind === 'SIZE_AND_APPLICABILITY' && ['PREPARED', 'REVIEWED'].includes(record.status))
  return <details className="mb-3" data-testid="hgb-review-policy">
    <summary><strong>{t('title')}: {t(policy?.mode === 'OWNER_SELF_REVIEW' ? 'self' : 'independent')}</strong></summary>
    <div className="mt-3">
      <p className="text-muted">{t('intro')}</p>
      {policy && <p className="text-break">{t('selected', { version: policy.version, actor: policy.selectedBy, date: new Date(policy.selectedAt).toLocaleString(locale) })}<br />{policy.reason}</p>}
      {collection?.reviewPolicyValid === false && <p className="alert alert-warning">{t('stale')}</p>}
      <fieldset disabled={busy || !collection?.canSelectReviewPolicy || collection.fiscalPeriod.status !== 'OPEN'}>
        <legend className="h6">{t('choose', { year })}</legend>
        <label className="form-label d-block">{t('method')}<select className="form-select" value={choice.mode} onChange={event => setChoice({ ...choice, mode: event.target.value as HgbReviewPolicyChoice['mode'] })}><option value="INDEPENDENT">{t('independent')}</option><option value="OWNER_SELF_REVIEW">{t('self')}</option></select></label>
        {self && <div className="alert alert-info">
          {!scopePrepared && <p>{t('prepareFirst')}</p>}
          <p>{t('scope')}</p>
          <label className="form-check"><input className="form-check-input" type="checkbox" checked={choice.soleShareholderManagingDirector} onChange={event => setChoice({ ...choice, soleShareholderManagingDirector: event.target.checked })} /><span>{t('soleOwner')}</span></label>
          <label className="form-check"><input className="form-check-input" type="checkbox" checked={choice.noAdditionalReviewRequirement} onChange={event => setChoice({ ...choice, noAdditionalReviewRequirement: event.target.checked })} /><span>{t('noExtraReview')}</span></label>
        </div>}
        <label className="form-label d-block">{t('reason')}<input className="form-control" value={choice.reason} onChange={event => setChoice({ ...choice, reason: event.target.value })} /></label>
        <label className="form-label d-block">{t('evidence')}<input className="form-control" value={choice.evidenceIds.join(', ')} onChange={event => setChoice({ ...choice, evidenceIds: event.target.value.split(',').map(id => id.trim()) })} /></label>
        <p className="form-text">{t('versionHint')}</p>
        <button type="button" className="btn btn-outline-primary" disabled={!canSaveReviewPolicy(choice, policy, collection?.reviewPolicyValid)} onClick={() => perform(() => api.selectReviewPolicy(year, choice, policy?.id ?? null, tenantId))}>{t(policy ? 'replace' : 'save')}</button>
      </fieldset>
    </div>
  </details>
}
