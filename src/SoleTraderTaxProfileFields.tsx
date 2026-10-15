'use client'

import { useId } from 'react'
import { useTranslations } from 'next-intl'
import type { SoleTraderTaxProfile } from './core/companyTaxProfile'

export function SoleTraderTaxProfileFields({ value, onChange }: { value?: SoleTraderTaxProfile; onChange: (value: SoleTraderTaxProfile) => void }) {
  const t = useTranslations('Euer'); const id = useId()
  const facts = value ?? { profitDetermination: 'BALANCE_SHEET', incomeType: 'TRADE', euerEligibilityConfirmed: false }
  return <fieldset className="compliance-profile-group">
    <legend>{t('profileTitle')}</legend>
    <label>{t('method')}<select className="form-select" value={value?.profitDetermination ?? ''} onChange={event => onChange({ ...facts, profitDetermination: event.target.value as SoleTraderTaxProfile['profitDetermination'], euerEligibilityConfirmed: false })}>
      <option value="" disabled>{t('selectMethod')}</option>
      <option value="BALANCE_SHEET">{t('balanceSheet')}</option><option value="EUER">{t('euer')}</option>
    </select></label>
    <label>{t('incomeType')}<select className="form-select" value={facts.incomeType} onChange={event => onChange({ ...facts, incomeType: event.target.value as SoleTraderTaxProfile['incomeType'] })}>
      <option value="TRADE">{t('trade')}</option><option value="SELF_EMPLOYED">{t('selfEmployed')}</option>
    </select></label>
    {facts.profitDetermination === 'EUER' && <div className="form-check">
      <input id={id} type="checkbox" className="form-check-input" checked={facts.euerEligibilityConfirmed} required onChange={event => onChange({ ...facts, euerEligibilityConfirmed: event.target.checked })} />
      <label htmlFor={id} className="form-check-label">{t('eligibility')}</label>
    </div>}
  </fieldset>
}
