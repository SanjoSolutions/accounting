"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import type { HgbCloseProfile, HgbWorkpaperKind } from './core/hgbClose'
import type { HgbWorkpaperDraft, HgbTypedSchedule } from './core/hgbWorkpapers'
import { browserHgbCloseApi, latestRunBlockers, operationStillCurrent, type HgbCloseApi, type HgbCloseOverview, type HgbWorkpaperCollection, type HgbWorkpaperRecordView } from './hgbCloseClient'

const kinds: readonly HgbWorkpaperKind[] = ['OPENING_BALANCE', 'MAPPING_AND_PRESENTATION', 'RECOGNITION_AND_OWNERSHIP', 'CUT_OFF_AND_ACCRUAL_DEFERRAL', 'PROVISIONS_AND_CONTINGENCIES', 'RECEIVABLE_AND_MARKET_VALUATION', 'FIXED_ASSETS_AND_DEPRECIATION', 'INVENTORY_COUNT_AND_VALUATION', 'SUBSEQUENT_EVENTS', 'GOING_CONCERN', 'POLICY_ELECTIONS', 'NOTES', 'GMBH_EQUITY_AND_RESULT', 'MICRO_NOTES_OMISSION', 'SIZE_AND_APPLICABILITY']
type BoolDraft = boolean | null
type ProfileDraft = Omit<HgbCloseProfile, 'germanRegisteredEntity' | 'publicInterestEntity' | 'capitalMarketOrListed' | 'regulatedIndustry' | 'liquidationOrInsolvencyBasis' | 'goingConcern' | 'formedOrConvertedInCurrentPeriod' | 'section5aApplies' | 'microNotesOmission'> & { [K in 'germanRegisteredEntity' | 'publicInterestEntity' | 'capitalMarketOrListed' | 'regulatedIndustry' | 'liquidationOrInsolvencyBasis' | 'goingConcern' | 'formedOrConvertedInCurrentPeriod' | 'section5aApplies']: BoolDraft } & { microNotesOmission?: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: BoolDraft; advancesAndLoansToManagementDisclosedBelowBalanceSheet: BoolDraft; requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: BoolDraft } }

export function initialHgbProfile(year: number): ProfileDraft {
  return {
    ruleSetVersion: 'HGB-DE-2024.1', legalForm: '', fiscalPeriodStart: `${year}-01-01`, fiscalPeriodEnd: `${year}-12-31`, germanRegisteredEntity: null,
    groupStatus: 'UNKNOWN', publicInterestEntity: null, capitalMarketOrListed: null, regulatedIndustry: null, liquidationOrInsolvencyBasis: null, goingConcern: null, formedOrConvertedInCurrentPeriod: null,
    currentSizeFacts: { balanceSheetTotalCents: 0, revenueCents: 0, quarterlyEmployeeCounts: [0, 0, 0, 0], microExcludedBySection267a: false },
    priorSizeFacts: { balanceSheetTotalCents: 0, revenueCents: 0, quarterlyEmployeeCounts: [0, 0, 0, 0], microExcludedBySection267a: false }, priorEstablishedSize: undefined,
    hasInventory: null, hasFixedAssets: null, section5aApplies: null,
  }
}

export function profileIsExplicit(profile: ProfileDraft): boolean {
  const flags = [profile.germanRegisteredEntity, profile.publicInterestEntity, profile.capitalMarketOrListed, profile.regulatedIndustry, profile.liquidationOrInsolvencyBasis, profile.goingConcern, profile.formedOrConvertedInCurrentPeriod, profile.section5aApplies, profile.hasInventory, profile.hasFixedAssets]
  return (profile.legalForm === 'GMBH' || profile.legalForm === 'UG') && profile.groupStatus !== 'UNKNOWN' && Boolean(profile.priorEstablishedSize) && flags.every(value => typeof value === 'boolean')
}

function scheduleFor(kind: HgbWorkpaperKind, year = new Date().getFullYear()): HgbTypedSchedule {
  const base = { applicability: 'APPLICABLE' as const, rationale: '' }
  switch (kind) {
    case 'OPENING_BALANCE': return { ...base, type: 'OPENING_BALANCE', priorClosingFingerprint: '', currentOpeningFingerprint: '', reconciled: false, reconciliationEvidenceId: '', approvedComparativeLeaves: [] }
    case 'MAPPING_AND_PRESENTATION': return { ...base, type: 'MAPPING_PRESENTATION', mappingVersionIds: [], allPostingAccountsMappedOnce: false, presentationReviewed: false, evidenceId: '' }
    case 'RECOGNITION_AND_OWNERSHIP': return { ...base, type: 'RECOGNITION_OWNERSHIP', items: [] }
    case 'CUT_OFF_AND_ACCRUAL_DEFERRAL': return { ...base, type: 'CUT_OFF_ACCRUAL_DEFERRAL', testedBeforeThrough: '', testedAfterThrough: '', populationEvidenceId: '', exceptionsResolved: false, items: [] }
    case 'PROVISIONS_AND_CONTINGENCIES': return { ...base, type: 'PROVISION_CONTINGENCY', items: [] }
    case 'RECEIVABLE_AND_MARKET_VALUATION': return { ...base, type: 'RECEIVABLE_MARKET_VALUATION', items: [] }
    case 'FIXED_ASSETS_AND_DEPRECIATION': return { ...base, type: 'FIXED_ASSET_VALUATION', valuationInputs: [], valuationResultIds: [], allAssetsValued: false, glReconciled: false, reconciliationEvidenceId: '', proposalIds: [] }
    case 'INVENTORY_COUNT_AND_VALUATION': return { ...base, type: 'INVENTORY_VALUATION', expectedItemIds: [], valuationInputs: [], valuationResultIds: [], countSnapshotId: '', allItemsValued: false, glReconciled: false, reconciliationEvidenceId: '', proposalIds: [] }
    case 'SUBSEQUENT_EVENTS': return { ...base, type: 'SUBSEQUENT_EVENTS', searchThrough: '', evidenceId: '', events: [] }
    case 'GOING_CONCERN': return { ...base, type: 'GOING_CONCERN', assessmentThrough: '', forecastEvidenceId: '', goingConcernAppropriate: false, materialUncertainty: false }
    case 'POLICY_ELECTIONS': return { ...base, type: 'POLICY_ELECTIONS', elections: [] }
    case 'NOTES': return { ...base, type: 'NOTES_QUESTIONNAIRE', notesRequired: true, questions: [] }
    case 'GMBH_EQUITY_AND_RESULT': return { ...base, type: 'GMBH_EQUITY_RESULT', shareCapitalCents: 0, resultCents: 0, equityReconciled: false, section5aReserveApplicable: false, evidenceId: '', proposalIds: [] }
    case 'MICRO_NOTES_OMISSION': return { ...base, type: 'MICRO_NOTES_OMISSION', section268Paragraph7Disclosed: false, managementLoansDisclosed: false, additionalTrueAndFairDisclosureAssessed: false, evidenceId: '' }
    case 'SIZE_AND_APPLICABILITY': return { ...base, type: 'SIZE_APPLICABILITY', legalForm: 'GMBH', establishedSize: 'SMALL', currentFactsEvidenceId: '', priorFactsEvidenceId: '', standaloneNoExemption: false, nonPieUnlistedUnregulated: false, closeProfile: initialHgbProfile(year) as HgbCloseProfile }
  }
}

export function newHgbWorkpaper(kind: HgbWorkpaperKind, year = new Date().getFullYear(), title: string = kind): HgbWorkpaperDraft {
  return { kind, title, conclusion: 'COMPLETE', evidenceIds: [], schedule: scheduleFor(kind, year), adjustments: [] }
}

const itemTemplates: Record<string, Record<string, unknown>> = {
  approvedComparativeLeaves: { lineId: '', amountCents: 0 },
  valuationInputs_FIXED_ASSET_VALUATION: { id: '', description: '', costBasisKind: 'ACQUISITION', costComponents: [], acquisitionDate: '', availableForUseDate: '', usefulLifeMonths: 0, depreciationConvention: 'FULL_MONTH', residualValueCents: 0, fiscalPeriod: { start: '', end: '' }, priorCumulativeImpairmentCents: 0, glCarryingAmountCents: 0, accounts: { assetAccount: '', expenseAccount: '', incomeAccount: '' }, evidenceIds: [] },
  valuationInputs_INVENTORY_VALUATION: { id: '', formula: 'FIFO', layers: [], issuedQuantity: 0, expectedQuantity: 0, countedQuantity: 0, countEvidenceIds: [], replacementCostPerUnitCents: 0, netRealizableValuePerUnitCents: 0, priorWriteDownCents: 0, glAmountCents: 0, accounts: { assetAccount: '', expenseAccount: '', incomeAccount: '' } },
  costComponents: { id: '', type: 'PURCHASE_PRICE', amountCents: 0, evidenceIds: [] }, layers: { id: '', date: '', quantity: 0, unitCostCents: 0, evidenceIds: [] },
  items_RECOGNITION_OWNERSHIP: { id: '', description: '', recognition: 'RECOGNIZE', ownershipEvidenceId: '', measurementBasis: '' },
  items_CUT_OFF_ACCRUAL_DEFERRAL: { id: '', category: 'PREPAID_EXPENSE', serviceFrom: '', serviceThrough: '', amountCents: 0, calculationEvidenceId: '', proposalId: '' },
  items_PROVISION_CONTINGENCY: { id: '', description: '', classification: 'NONE', obligationEvidenceId: '', bestEstimateCents: 0, estimationMethod: '', proposalId: '', supportedEstimate: false },
  items_RECEIVABLE_MARKET_VALUATION: { id: '', accountId: '', grossCents: 0, recoverableCents: 0, valuationEvidenceId: '', proposalId: '' },
  events_SUBSEQUENT_EVENTS: { id: '', description: '', treatment: 'NO_EFFECT', proposalId: '', notesDisclosureRequired: false },
  elections_POLICY_ELECTIONS: { id: '', policy: 'COST_METHOD', selected: false, rationale: '', applicable: true },
  questions_NOTES_QUESTIONNAIRE: { id: '', required: false, answer: 'NO', disclosureText: '', evidenceId: '' },
  adjustments_root: { id: '', bookingDate: '', description: '', evidenceIds: [], lines: [] },
  lines_root: { accountId: '', debitCents: 0, creditCents: 0, memo: '' },
}

export function structuredItemTemplate(key: string, typeOrContext: string): Record<string, unknown> | undefined {
  return itemTemplates[`${key}_${typeOrContext}`] ?? itemTemplates[key] ?? itemTemplates[`${key}_root`]
}

const enumOptions: Record<string, string[]> = { applicability: ['APPLICABLE', 'NOT_APPLICABLE', 'UNSUPPORTED'], conclusion: ['COMPLETE', 'NOT_APPLICABLE', 'UNSUPPORTED_COMPLEX_FACTS'], recognition: ['RECOGNIZE', 'DO_NOT_RECOGNIZE'], category: ['PREPAID_EXPENSE', 'DEFERRED_INCOME', 'ACCRUED_EXPENSE', 'ACCRUED_INCOME'], classification: ['PROVISION', 'CONTINGENT_LIABILITY', 'NONE'], treatment: ['ADJUSTING', 'NON_ADJUSTING', 'NO_EFFECT'], answer: ['YES', 'NO', 'NOT_APPLICABLE'], policy: ['COST_METHOD', 'TOTAL_COST_PNL', 'FUNCTION_OF_EXPENSE_PNL', 'FIFO', 'LIFO', 'WEIGHTED_AVERAGE'], legalForm: ['GMBH', 'UG'], groupStatus: ['UNKNOWN', 'STANDALONE_NO_EXEMPTION', 'PARENT', 'SUBSIDIARY', 'CONSOLIDATED', 'SECTION_264_3_EXEMPTION'], establishedSize: ['MICRO', 'SMALL'], costBasisKind: ['ACQUISITION', 'PRODUCTION'], depreciationConvention: ['FULL_MONTH'], formula: ['FIFO', 'WEIGHTED_AVERAGE', 'LIFO'], type: ['PURCHASE_PRICE', 'PURCHASE_PRICE_REDUCTION', 'ACQUISITION_INCIDENTAL', 'SUBSEQUENT_ACQUISITION', 'DIRECT_MATERIAL', 'DIRECT_LABOUR', 'SPECIAL_PRODUCTION', 'MATERIAL_OVERHEAD', 'PRODUCTION_OVERHEAD', 'PRODUCTION_DEPRECIATION'] }

function StructuredFields({ value, onChange, context = 'root' }: { value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; context?: string }) {
  const t = useTranslations('HgbCloseWorkbench')
  return <div className="hgb-fields">{Object.entries(value).filter(([key]) => key !== 'kind' && !(key === 'type' && context.endsWith('schedule'))).map(([key, field]) => {
    const set = (next: unknown) => onChange({ ...value, [key]: next })
    const label = t(`fields.${key}`)
    if (typeof field === 'boolean') return <label className="form-check" data-field-key={key} key={key}><input className="form-check-input" type="checkbox" checked={field} onChange={event => set(event.target.checked)} /><span>{label}</span></label>
    if (typeof field === 'number') return <label data-field-key={key} key={key}>{label}<input className="form-control" type="number" step="1" value={field} onChange={event => set(Number(event.target.value))} /></label>
    if (Array.isArray(field)) {
      if (!field.length || field.every(item => typeof item === 'string')) {
        const template = structuredItemTemplate(key, String(value.type ?? context))
        if (!template) return <label key={key}>{label}<input className="form-control" value={(field as string[]).join(', ')} onChange={event => set(event.target.value.split(',').map(item => item.trim()).filter(Boolean))} placeholder={t('actions.idsPlaceholder')} /></label>
        return <fieldset key={key}><legend>{label}</legend>{field.map((item, index) => <div className="card panel" key={index}><StructuredFields value={item as Record<string, unknown>} onChange={next => set(field.map((old, i) => i === index ? next : old))} context="root" /><button type="button" className="btn btn-outline-secondary" onClick={() => set(field.filter((_, i) => i !== index))}>{t('actions.removeRow')}</button></div>)}<button type="button" className="btn btn-outline-secondary" onClick={() => set([...field, structuredClone(template)])}>{t('actions.addRow')}</button></fieldset>
      }
      return <fieldset key={key}><legend>{label}</legend>{field.map((item, index) => <div className="card panel" key={index}><StructuredFields value={item as Record<string, unknown>} onChange={next => set(field.map((old, i) => i === index ? next : old))} context="root" /><button type="button" className="btn btn-outline-secondary" onClick={() => set(field.filter((_, i) => i !== index))}>{t('actions.removeRow')}</button></div>)}<button type="button" className="btn btn-outline-secondary" onClick={() => set([...field, structuredClone(structuredItemTemplate(key, String(value.type ?? context)) ?? {})])}>{t('actions.addRow')}</button></fieldset>
    }
    if (field && typeof field === 'object') return <fieldset data-field-key={key} key={key}><legend>{label}</legend><StructuredFields value={field as Record<string, unknown>} onChange={set} context={key} /></fieldset>
    const options = enumOptions[key]
    return <label data-field-key={key} key={key}>{label}{options ? <select className="form-select" value={String(field ?? '')} onChange={event => set(event.target.value)}>{options.map(option => <option key={option} value={option}>{t(`enum.${option}`)}</option>)}</select> : <input className="form-control" type={key.toLowerCase().includes('date') || key.endsWith('Through') ? 'date' : 'text'} value={String(field ?? '')} onChange={event => set(event.target.value)} />}</label>
  })}</div>
}

function ExplicitBoolean({ label, value, onChange }: { label: string; value: BoolDraft; onChange: (value: BoolDraft) => void }) {
  const t = useTranslations('HgbCloseWorkbench')
  return <label>{label}<select className="form-select" value={value === null ? '' : String(value)} onChange={event => onChange(event.target.value === '' ? null : event.target.value === 'true')}><option value="">{t('actions.notAnswered')}</option><option value="true">{t('actions.yes')}</option><option value="false">{t('actions.no')}</option></select></label>
}

export function HgbCloseWorkbench({ year, tenantId, api = browserHgbCloseApi, onChanged }: { year: number; tenantId?: string; api?: HgbCloseApi; onChanged?: () => void }) {
  const t = useTranslations('HgbCloseWorkbench')
  const workpaperTitle = (kind: HgbWorkpaperKind) => {
    switch (kind) {
      case 'OPENING_BALANCE': return t('kinds.OPENING_BALANCE')
      case 'MAPPING_AND_PRESENTATION': return t('kinds.MAPPING_AND_PRESENTATION')
      case 'RECOGNITION_AND_OWNERSHIP': return t('kinds.RECOGNITION_AND_OWNERSHIP')
      case 'CUT_OFF_AND_ACCRUAL_DEFERRAL': return t('kinds.CUT_OFF_AND_ACCRUAL_DEFERRAL')
      case 'PROVISIONS_AND_CONTINGENCIES': return t('kinds.PROVISIONS_AND_CONTINGENCIES')
      case 'RECEIVABLE_AND_MARKET_VALUATION': return t('kinds.RECEIVABLE_AND_MARKET_VALUATION')
      case 'FIXED_ASSETS_AND_DEPRECIATION': return t('kinds.FIXED_ASSETS_AND_DEPRECIATION')
      case 'INVENTORY_COUNT_AND_VALUATION': return t('kinds.INVENTORY_COUNT_AND_VALUATION')
      case 'SUBSEQUENT_EVENTS': return t('kinds.SUBSEQUENT_EVENTS')
      case 'GOING_CONCERN': return t('kinds.GOING_CONCERN')
      case 'POLICY_ELECTIONS': return t('kinds.POLICY_ELECTIONS')
      case 'NOTES': return t('kinds.NOTES')
      case 'GMBH_EQUITY_AND_RESULT': return t('kinds.GMBH_EQUITY_AND_RESULT')
      case 'MICRO_NOTES_OMISSION': return t('kinds.MICRO_NOTES_OMISSION')
      case 'SIZE_AND_APPLICABILITY': return t('kinds.SIZE_AND_APPLICABILITY')
    }
  }
  const [overview, setOverview] = useState<HgbCloseOverview>()
  const [collection, setCollection] = useState<HgbWorkpaperCollection>()
  const [profile, setProfile] = useState<ProfileDraft>(() => initialHgbProfile(year))
  const [selectedKind, setSelectedKind] = useState<HgbWorkpaperKind>('SIZE_AND_APPLICABILITY')
  const [draft, setDraft] = useState<HgbWorkpaperDraft>(() => newHgbWorkpaper('SIZE_AND_APPLICABILITY', year, workpaperTitle('SIZE_AND_APPLICABILITY')))
  const [reason, setReason] = useState('')
  const [annualPackageId, setAnnualPackageId] = useState('')
  const [representatives, setRepresentatives] = useState(''); const [signatureEvidence, setSignatureEvidence] = useState(''); const [signedAt, setSignedAt] = useState(''); const [resolutionId, setResolutionId] = useState('')
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const yearRef = useRef(year); const generationRef = useRef(0)
  const load = useCallback(async (signal?: AbortSignal) => {
    const requestedYear = year; const generation = ++generationRef.current
    try {
      const [nextOverview, nextCollection] = await Promise.all([api.loadOverview(year, signal, tenantId), api.loadWorkpapers(year, signal, tenantId)])
      if (operationStillCurrent(requestedYear, yearRef.current, generation, generationRef.current) && !signal?.aborted) { setOverview(nextOverview); setCollection(nextCollection); setAnnualPackageId(current => nextOverview.approvedAnnualPackages.some(item => item.id === current) ? current : nextOverview.approvedAnnualPackages[0]?.id ?? ''); setError('') }
    } catch (caught) { if ((caught as { name?: string }).name !== 'AbortError' && operationStillCurrent(requestedYear, yearRef.current, generation, generationRef.current)) setError((caught as Error).message) }
  }, [api, tenantId, year])
  useEffect(() => { yearRef.current = year; generationRef.current++; setOverview(undefined); setCollection(undefined); setProfile(initialHgbProfile(year)); setDraft(newHgbWorkpaper('SIZE_AND_APPLICABILITY', year, workpaperTitle('SIZE_AND_APPLICABILITY'))); const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [load, t, year])
  const selected = collection?.workpapers.find(item => item.kind === selectedKind)
  function choose(kind: HgbWorkpaperKind) { setSelectedKind(kind); setDraft(structuredClone(collection?.workpapers.find(item => item.kind === kind)?.payload ?? newHgbWorkpaper(kind, year, workpaperTitle(kind)))); setError('') }
  async function perform(action: () => Promise<void>) { const requestedYear = year; const generation = ++generationRef.current; setBusy(true); setError(''); try { await action(); if (requestedYear === yearRef.current) { await load(); onChanged?.() } } catch (caught) { if (operationStillCurrent(requestedYear, yearRef.current, generation, generationRef.current)) setError((caught as Error).message) } finally { if (requestedYear === yearRef.current) setBusy(false) } }
  const latest = overview?.runs?.[0]
  const blockers = latestRunBlockers(latest)
  const statusLabel = latest ? t(`status.${latest.status}`) : t('status.NOT_EVALUATED')
  return <section className="card panel hgb-workbench" aria-labelledby="hgb-workbench-title">
    <div className="panel-title"><div><span className="step">{t('step')}</span><h2 id="hgb-workbench-title">{t('title')}</h2></div><span className={`status ${latest?.status === 'READY_TO_LOCK' ? 'closed' : 'open'}`}>{statusLabel}</span></div>
    <p>{t('intro')}</p>
    {error && <p className="alert alert-danger" role="alert">{error}</p>}
    {blockers.length ? <div className="alert alert-warning"><strong>{t('blockersTitle')}</strong><ul>{blockers.map(blocker => <li key={`${blocker.code}-${blocker.message}`}>{blocker.message} <small>({blocker.authority})</small></li>)}</ul></div> : null}
    <details><summary><strong>{t('sections.profile')}</strong></summary><div className="hgb-fields mt-3">
      <label>{t('profile.legalForm')}<select className="form-select" value={profile.legalForm} onChange={e => setProfile({ ...profile, legalForm: e.target.value })}><option value="">{t('profile.notAnswered')}</option><option value="GMBH">{t('enum.GMBH')}</option><option value="UG">{t('enum.UG')}</option></select></label>
      <label>{t('profile.groupStatus')}<select className="form-select" value={profile.groupStatus} onChange={e => setProfile({ ...profile, groupStatus: e.target.value as ProfileDraft['groupStatus'] })}>{['UNKNOWN', 'STANDALONE_NO_EXEMPTION', 'PARENT', 'SUBSIDIARY', 'CONSOLIDATED', 'SECTION_264_3_EXEMPTION'].map(option => <option key={option} value={option}>{t(`enum.${option}`)}</option>)}</select></label>
      <label>{t('profile.periodStart')}<input className="form-control" type="date" value={profile.fiscalPeriodStart} onChange={e => setProfile({ ...profile, fiscalPeriodStart: e.target.value })} /></label><label>{t('profile.periodEnd')}<input className="form-control" type="date" value={profile.fiscalPeriodEnd} onChange={e => setProfile({ ...profile, fiscalPeriodEnd: e.target.value })} /></label>
      <ExplicitBoolean label={t('profile.germanRegistered')} value={profile.germanRegisteredEntity} onChange={value => setProfile({ ...profile, germanRegisteredEntity: value })} />
      <ExplicitBoolean label={t('profile.publicInterest')} value={profile.publicInterestEntity} onChange={value => setProfile({ ...profile, publicInterestEntity: value })} /><ExplicitBoolean label={t('profile.capitalMarket')} value={profile.capitalMarketOrListed} onChange={value => setProfile({ ...profile, capitalMarketOrListed: value })} /><ExplicitBoolean label={t('profile.regulatedIndustry')} value={profile.regulatedIndustry} onChange={value => setProfile({ ...profile, regulatedIndustry: value })} />
      <ExplicitBoolean label={t('profile.liquidationBasis')} value={profile.liquidationOrInsolvencyBasis} onChange={value => setProfile({ ...profile, liquidationOrInsolvencyBasis: value })} /><ExplicitBoolean label={t('profile.goingConcern')} value={profile.goingConcern} onChange={value => setProfile({ ...profile, goingConcern: value })} /><ExplicitBoolean label={t('profile.formedOrConverted')} value={profile.formedOrConvertedInCurrentPeriod} onChange={value => setProfile({ ...profile, formedOrConvertedInCurrentPeriod: value })} /><ExplicitBoolean label={t('profile.section5a')} value={profile.section5aApplies} onChange={value => setProfile({ ...profile, section5aApplies: value })} />
      <ExplicitBoolean label={t('profile.hasInventory')} value={profile.hasInventory} onChange={value => setProfile({ ...profile, hasInventory: value })} /><ExplicitBoolean label={t('profile.hasFixedAssets')} value={profile.hasFixedAssets} onChange={value => setProfile({ ...profile, hasFixedAssets: value })} />
      <fieldset><legend>{t('profile.microNotesTitle')}</legend><p>{t('profile.microNotesDescription')}</p><ExplicitBoolean label={t('profile.section268')} value={profile.microNotesOmission?.requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet ?? null} onChange={value => setProfile({ ...profile, microNotesOmission: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: value, advancesAndLoansToManagementDisclosedBelowBalanceSheet: profile.microNotesOmission?.advancesAndLoansToManagementDisclosedBelowBalanceSheet ?? null, requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: profile.microNotesOmission?.requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet ?? null } })} /><ExplicitBoolean label={t('profile.managementLoans')} value={profile.microNotesOmission?.advancesAndLoansToManagementDisclosedBelowBalanceSheet ?? null} onChange={value => setProfile({ ...profile, microNotesOmission: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: profile.microNotesOmission?.requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet ?? null, advancesAndLoansToManagementDisclosedBelowBalanceSheet: value, requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: profile.microNotesOmission?.requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet ?? null } })} /><ExplicitBoolean label={t('profile.trueAndFair')} value={profile.microNotesOmission?.requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet ?? null} onChange={value => setProfile({ ...profile, microNotesOmission: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: profile.microNotesOmission?.requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet ?? null, advancesAndLoansToManagementDisclosedBelowBalanceSheet: profile.microNotesOmission?.advancesAndLoansToManagementDisclosedBelowBalanceSheet ?? null, requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: value } })} /></fieldset>
      <SizeFacts title={t('profile.currentFacts')} value={profile.currentSizeFacts} onChange={currentSizeFacts => setProfile({ ...profile, currentSizeFacts })} /><SizeFacts title={t('profile.priorFacts')} value={profile.priorSizeFacts!} onChange={priorSizeFacts => setProfile({ ...profile, priorSizeFacts })} />
      <label>{t('profile.priorEstablishedSize')}<select className="form-select" value={profile.priorEstablishedSize ?? ''} onChange={e => setProfile({ ...profile, priorEstablishedSize: e.target.value as ProfileDraft['priorEstablishedSize'] || undefined })}><option value="">{t('profile.notAnswered')}</option><option value="MICRO">{t('enum.MICRO')}</option><option value="SMALL">{t('enum.SMALL')}</option></select></label>
      <p>{t('profile.profileBinding')}</p>
    </div></details>
    <details open><summary><strong>{t('sections.workpapers')}</strong></summary><div className="mt-3"><label>{t('fields.kind')}<select className="form-select" value={selectedKind} onChange={e => choose(e.target.value as HgbWorkpaperKind)}>{kinds.map(kind => { const record = collection?.workpapers.find(item => item.kind === kind); return <option key={kind} value={kind}>{workpaperTitle(kind)} · {record ? t(`status.${record.status}`) : t('status.MISSING')}</option> })}</select></label>
      <StructuredFields value={draft as unknown as Record<string, unknown>} onChange={next => setDraft(next as unknown as HgbWorkpaperDraft)} />
      <div className="action-stack"><button className="btn btn-primary" disabled={busy || collection?.fiscalPeriod.status !== 'OPEN' || selectedKind === 'SIZE_AND_APPLICABILITY' && !profileIsExplicit(profile)} onClick={() => perform(async () => { const candidate = selectedKind === 'SIZE_AND_APPLICABILITY' ? { ...draft, schedule: { ...draft.schedule, closeProfile: profile as HgbCloseProfile } } as HgbWorkpaperDraft : draft; await api.saveWorkpaper(year, candidate, selected?.status === 'DRAFT' ? selected.checksum : undefined, tenantId) })}>{t('actions.saveDraft')}</button>{selected && <WorkpaperActions year={year} tenantId={tenantId} record={selected} busy={busy} perform={perform} api={api} />}</div>
    </div></details>
    <details><summary><strong>{t('sections.approval')}</strong></summary><div className="hgb-fields mt-3"><label>{t('approval.annualAccounts')}<select className="form-select" value={annualPackageId} onChange={e => setAnnualPackageId(e.target.value)}><option value="">{t('approval.notSelected')}</option>{overview?.approvedAnnualPackages.map(item => <option key={item.id} value={item.id}>{t('approval.version', { version: item.version })} · {item.id}</option>)}</select></label><label>{t('approval.representatives')}<input className="form-control" value={representatives} onChange={e => setRepresentatives(e.target.value)} placeholder={t('approval.representativesPlaceholder')} /></label><label>{t('approval.signatureEvidence')}<input className="form-control" value={signatureEvidence} onChange={e => setSignatureEvidence(e.target.value)} placeholder={t('approval.evidencePlaceholder')} /></label><label>{t('approval.signedAt')}<input className="form-control" type="datetime-local" value={signedAt} onChange={e => setSignedAt(e.target.value)} /></label><label>{t('approval.shareholderResolution')}<input className="form-control" value={resolutionId} onChange={e => setResolutionId(e.target.value)} /></label><label>{t('approval.reason')}<input className="form-control" value={reason} onChange={e => setReason(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={busy || !reason.trim() || !annualPackageId} onClick={() => { const annualPackage = overview?.approvedAnnualPackages.find(item => item.id === annualPackageId); return perform(() => api.evaluate(year, evaluationInput(representatives, signatureEvidence, signedAt, resolutionId, reason, annualPackage), tenantId)) }}>{t('approval.evaluate')}</button></div></details>
  </section>
}

function SizeFacts({ title, value, onChange }: { title: string; value: HgbCloseProfile['currentSizeFacts']; onChange: (value: HgbCloseProfile['currentSizeFacts']) => void }) {
  const t = useTranslations('HgbCloseWorkbench')
  const employees = [...value.quarterlyEmployeeCounts] as [number, number, number, number]
  return <fieldset><legend>{title}</legend><label>{t('fields.balanceSheetTotalCents')}<input className="form-control" type="number" value={value.balanceSheetTotalCents} onChange={e => onChange({ ...value, balanceSheetTotalCents: Number(e.target.value) })} /></label><label>{t('fields.revenueCents')}<input className="form-control" type="number" value={value.revenueCents} onChange={e => onChange({ ...value, revenueCents: Number(e.target.value) })} /></label>{employees.map((count, index) => <label key={index}>{t('fields.quarterlyEmployees', { quarter: index + 1 })}<input className="form-control" type="number" value={count} onChange={e => { const next = [...employees] as typeof employees; next[index] = Number(e.target.value); onChange({ ...value, quarterlyEmployeeCounts: next }) }} /></label>)}<label className="form-check"><input className="form-check-input" type="checkbox" checked={value.microExcludedBySection267a} onChange={e => onChange({ ...value, microExcludedBySection267a: e.target.checked })} />{t('fields.microExcludedBySection267a')}</label></fieldset>
}

function WorkpaperActions({ year, tenantId, record, busy, perform, api }: { year: number; tenantId?: string; record: HgbWorkpaperRecordView; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; api: HgbCloseApi }) {
  const t = useTranslations('HgbCloseWorkbench')
  const [reviewReason, setReviewReason] = useState('')
  const buttons: ReactNode[] = []
  if (record.status === 'DRAFT' || record.status === 'REJECTED') buttons.push(<button key="prepare" className="btn btn-outline-secondary" disabled={busy} onClick={() => perform(() => api.prepareWorkpaper(year, record, tenantId))}>{t('actions.markPrepared')}</button>)
  if (record.status === 'PREPARED') buttons.push(<label key="reason">{t('actions.reviewReason')}<input className="form-control" value={reviewReason} onChange={e => setReviewReason(e.target.value)} /></label>, <button key="approve" className="btn btn-outline-secondary" disabled={busy} onClick={() => perform(() => api.reviewWorkpaper(year, record, 'APPROVE', reviewReason, tenantId))}>{t('actions.approve')}</button>, <button key="reject" className="btn btn-outline-secondary" disabled={busy || !reviewReason.trim()} onClick={() => perform(() => api.reviewWorkpaper(year, record, 'REJECT', reviewReason, tenantId))}>{t('actions.reject')}</button>)
  if (record.status === 'REVIEWED') for (const adjustment of record.adjustments.filter(item => item.status !== 'POSTED')) buttons.push(<button key={adjustment.proposalId} className="btn btn-outline-secondary" disabled={busy} onClick={() => perform(() => api.postAdjustment(year, record, adjustment.proposalId, tenantId))}>{t('actions.postAdjustment', { id: adjustment.proposalId })}</button>)
  return <>{buttons}</>
}

export function evaluationInput(representativesText: string, evidenceText: string, signedAt: string, shareholderResolutionId: string, reason: string, annualPackage?: { id: string; checksum: string }) {
  const legalRepresentativeIds = representativesText.split(',').map(value => value.trim()).filter(Boolean); const evidenceIds = evidenceText.split(',').map(value => value.trim()).filter(Boolean)
  return { reason, annualAccountsPackageId: annualPackage?.id, annualAccountsChecksum: annualPackage?.checksum, legalRepresentativeIds, managingDirectorSignatures: legalRepresentativeIds.map((representativeId, index) => ({ representativeId, signedAt: signedAt ? new Date(signedAt).toISOString() : '', signatureEvidenceId: evidenceIds[index] ?? '' })), shareholderResolutionId }
}
