"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { HgbCloseProfile, HgbWorkpaperKind } from './core/hgbClose'
import type { HgbWorkpaperDraft, HgbTypedSchedule } from './core/hgbWorkpapers'
import { browserHgbCloseApi, latestRunBlockers, operationStillCurrent, type HgbCloseApi, type HgbCloseOverview, type HgbWorkpaperCollection, type HgbWorkpaperRecordView } from './hgbCloseClient'

const kinds: readonly HgbWorkpaperKind[] = ['OPENING_BALANCE', 'MAPPING_AND_PRESENTATION', 'RECOGNITION_AND_OWNERSHIP', 'CUT_OFF_AND_ACCRUAL_DEFERRAL', 'PROVISIONS_AND_CONTINGENCIES', 'RECEIVABLE_AND_MARKET_VALUATION', 'FIXED_ASSETS_AND_DEPRECIATION', 'INVENTORY_COUNT_AND_VALUATION', 'SUBSEQUENT_EVENTS', 'GOING_CONCERN', 'POLICY_ELECTIONS', 'NOTES', 'GMBH_EQUITY_AND_RESULT', 'MICRO_NOTES_OMISSION', 'SIZE_AND_APPLICABILITY']
const titles: Record<HgbWorkpaperKind, string> = {
  OPENING_BALANCE: 'Eröffnungsbilanz', MAPPING_AND_PRESENTATION: 'Kontenzuordnung und Ausweis', RECOGNITION_AND_OWNERSHIP: 'Ansatz und wirtschaftliches Eigentum', CUT_OFF_AND_ACCRUAL_DEFERRAL: 'Periodenabgrenzung', PROVISIONS_AND_CONTINGENCIES: 'Rückstellungen und Haftungsverhältnisse', RECEIVABLE_AND_MARKET_VALUATION: 'Forderungs- und Marktpreisbewertung', FIXED_ASSETS_AND_DEPRECIATION: 'Anlagen und Abschreibungen', INVENTORY_COUNT_AND_VALUATION: 'Inventur und Vorratsbewertung', SUBSEQUENT_EVENTS: 'Ereignisse nach dem Stichtag', GOING_CONCERN: 'Fortführungsprognose', POLICY_ELECTIONS: 'Bilanzierungswahlrechte', NOTES: 'Anhangangaben', GMBH_EQUITY_AND_RESULT: 'Eigenkapital und Ergebnisverwendung', MICRO_NOTES_OMISSION: 'Anhangbefreiung für Kleinstkapitalgesellschaften', SIZE_AND_APPLICABILITY: 'Größenklasse und Anwendungsbereich',
}

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

export function newHgbWorkpaper(kind: HgbWorkpaperKind, year = new Date().getFullYear()): HgbWorkpaperDraft {
  return { kind, title: titles[kind], conclusion: 'COMPLETE', evidenceIds: [], schedule: scheduleFor(kind, year), adjustments: [] }
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

const labels: Record<string, string> = { rationale: 'Begründung', applicability: 'Anwendbarkeit', evidenceIds: 'Nachweise', conclusion: 'Schlussfolgerung', title: 'Bezeichnung', adjustments: 'Buchungsvorschläge', lines: 'Buchungszeilen', debitCents: 'Soll (Cent)', creditCents: 'Haben (Cent)', accountId: 'Konto-ID', bookingDate: 'Buchungsdatum', description: 'Beschreibung', id: 'ID', items: 'Prüfpositionen', events: 'Ereignisse', questions: 'Anhangfragen', elections: 'Wahlrechte' }
const enumOptions: Record<string, string[]> = { applicability: ['APPLICABLE', 'NOT_APPLICABLE', 'UNSUPPORTED'], conclusion: ['COMPLETE', 'NOT_APPLICABLE', 'UNSUPPORTED_COMPLEX_FACTS'], recognition: ['RECOGNIZE', 'DO_NOT_RECOGNIZE'], category: ['PREPAID_EXPENSE', 'DEFERRED_INCOME', 'ACCRUED_EXPENSE', 'ACCRUED_INCOME'], classification: ['PROVISION', 'CONTINGENT_LIABILITY', 'NONE'], treatment: ['ADJUSTING', 'NON_ADJUSTING', 'NO_EFFECT'], answer: ['YES', 'NO', 'NOT_APPLICABLE'], policy: ['COST_METHOD', 'TOTAL_COST_PNL', 'FUNCTION_OF_EXPENSE_PNL', 'FIFO', 'LIFO', 'WEIGHTED_AVERAGE'], legalForm: ['GMBH', 'UG'], establishedSize: ['MICRO', 'SMALL'], costBasisKind: ['ACQUISITION', 'PRODUCTION'], depreciationConvention: ['FULL_MONTH'], formula: ['FIFO', 'WEIGHTED_AVERAGE', 'LIFO'], type: ['PURCHASE_PRICE', 'PURCHASE_PRICE_REDUCTION', 'ACQUISITION_INCIDENTAL', 'SUBSEQUENT_ACQUISITION', 'DIRECT_MATERIAL', 'DIRECT_LABOUR', 'SPECIAL_PRODUCTION', 'MATERIAL_OVERHEAD', 'PRODUCTION_OVERHEAD', 'PRODUCTION_DEPRECIATION'] }

function StructuredFields({ value, onChange, context = 'root' }: { value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void; context?: string }) {
  return <div className="hgb-fields">{Object.entries(value).filter(([key]) => key !== 'kind' && !(key === 'type' && context.endsWith('schedule'))).map(([key, field]) => {
    const set = (next: unknown) => onChange({ ...value, [key]: next })
    const label = labels[key] ?? key.replaceAll(/([A-Z])/g, ' $1')
    if (typeof field === 'boolean') return <label className="form-check" data-field-key={key} key={key}><input className="form-check-input" type="checkbox" checked={field} onChange={event => set(event.target.checked)} /><span>{label}</span></label>
    if (typeof field === 'number') return <label data-field-key={key} key={key}>{label}<input className="form-control" type="number" step="1" value={field} onChange={event => set(Number(event.target.value))} /></label>
    if (Array.isArray(field)) {
      if (!field.length || field.every(item => typeof item === 'string')) {
        const template = structuredItemTemplate(key, String(value.type ?? context))
        if (!template) return <label key={key}>{label}<input className="form-control" value={(field as string[]).join(', ')} onChange={event => set(event.target.value.split(',').map(item => item.trim()).filter(Boolean))} placeholder="IDs, durch Komma getrennt" /></label>
        return <fieldset key={key}><legend>{label}</legend>{field.map((item, index) => <div className="card panel" key={index}><StructuredFields value={item as Record<string, unknown>} onChange={next => set(field.map((old, i) => i === index ? next : old))} context="root" /><button type="button" className="btn btn-outline-secondary" onClick={() => set(field.filter((_, i) => i !== index))}>Zeile entfernen</button></div>)}<button type="button" className="btn btn-outline-secondary" onClick={() => set([...field, structuredClone(template)])}>Zeile hinzufügen</button></fieldset>
      }
      return <fieldset key={key}><legend>{label}</legend>{field.map((item, index) => <div className="card panel" key={index}><StructuredFields value={item as Record<string, unknown>} onChange={next => set(field.map((old, i) => i === index ? next : old))} context="root" /><button type="button" className="btn btn-outline-secondary" onClick={() => set(field.filter((_, i) => i !== index))}>Zeile entfernen</button></div>)}<button type="button" className="btn btn-outline-secondary" onClick={() => set([...field, structuredClone(structuredItemTemplate(key, String(value.type ?? context)) ?? {})])}>Zeile hinzufügen</button></fieldset>
    }
    if (field && typeof field === 'object') return <fieldset data-field-key={key} key={key}><legend>{label}</legend><StructuredFields value={field as Record<string, unknown>} onChange={set} context={key} /></fieldset>
    const options = enumOptions[key]
    return <label data-field-key={key} key={key}>{label}{options ? <select className="form-select" value={String(field ?? '')} onChange={event => set(event.target.value)}>{options.map(option => <option key={option}>{option}</option>)}</select> : <input className="form-control" type={key.toLowerCase().includes('date') || key.endsWith('Through') ? 'date' : 'text'} value={String(field ?? '')} onChange={event => set(event.target.value)} />}</label>
  })}</div>
}

function ExplicitBoolean({ label, value, onChange }: { label: string; value: BoolDraft; onChange: (value: BoolDraft) => void }) {
  return <label>{label}<select className="form-select" value={value === null ? '' : String(value)} onChange={event => onChange(event.target.value === '' ? null : event.target.value === 'true')}><option value="">Nicht beantwortet</option><option value="true">Ja</option><option value="false">Nein</option></select></label>
}

export function HgbCloseWorkbench({ year, tenantId, api = browserHgbCloseApi, onChanged }: { year: number; tenantId?: string; api?: HgbCloseApi; onChanged?: () => void }) {
  const [overview, setOverview] = useState<HgbCloseOverview>()
  const [collection, setCollection] = useState<HgbWorkpaperCollection>()
  const [profile, setProfile] = useState<ProfileDraft>(() => initialHgbProfile(year))
  const [selectedKind, setSelectedKind] = useState<HgbWorkpaperKind>('SIZE_AND_APPLICABILITY')
  const [draft, setDraft] = useState<HgbWorkpaperDraft>(() => newHgbWorkpaper('SIZE_AND_APPLICABILITY', year))
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
  useEffect(() => { yearRef.current = year; generationRef.current++; setOverview(undefined); setCollection(undefined); setProfile(initialHgbProfile(year)); setDraft(newHgbWorkpaper('SIZE_AND_APPLICABILITY', year)); const controller = new AbortController(); void load(controller.signal); return () => controller.abort() }, [load, year])
  const selected = collection?.workpapers.find(item => item.kind === selectedKind)
  function choose(kind: HgbWorkpaperKind) { setSelectedKind(kind); setDraft(structuredClone(collection?.workpapers.find(item => item.kind === kind)?.payload ?? newHgbWorkpaper(kind, year))); setError('') }
  async function perform(action: () => Promise<void>) { const requestedYear = year; const generation = ++generationRef.current; setBusy(true); setError(''); try { await action(); if (requestedYear === yearRef.current) { await load(); onChanged?.() } } catch (caught) { if (operationStillCurrent(requestedYear, yearRef.current, generation, generationRef.current)) setError((caught as Error).message) } finally { if (requestedYear === yearRef.current) setBusy(false) } }
  const latest = overview?.runs?.[0]
  const blockers = latestRunBlockers(latest)
  return <section className="card panel hgb-workbench" aria-labelledby="hgb-workbench-title">
    <div className="panel-title"><div><span className="step">HGB-Arbeitspapiere</span><h2 id="hgb-workbench-title">Geführte Abschlussakte</h2></div><span className={`status ${latest?.status === 'READY_TO_LOCK' ? 'closed' : 'open'}`}>{latest?.status ?? 'Noch nicht bewertet'}</span></div>
    <p>Alle Angaben werden strukturiert und jahresbezogen erfasst. Unbeantwortete oder nicht unterstützte Sachverhalte blockieren die Festschreibung.</p>
    {error && <p className="alert alert-danger" role="alert">{error}</p>}
    {blockers.length ? <div className="alert alert-warning"><strong>Blocker des letzten Laufs</strong><ul>{blockers.map(blocker => <li key={`${blocker.code}-${blocker.message}`}>{blocker.message} <small>({blocker.authority})</small></li>)}</ul></div> : null}
    <details><summary><strong>1. Unternehmensprofil und Größenmerkmale</strong></summary><div className="hgb-fields mt-3">
      <label>Rechtsform<select className="form-select" value={profile.legalForm} onChange={e => setProfile({ ...profile, legalForm: e.target.value })}><option value="">Nicht beantwortet</option><option>GMBH</option><option>UG</option></select></label>
      <label>Konzernstatus<select className="form-select" value={profile.groupStatus} onChange={e => setProfile({ ...profile, groupStatus: e.target.value as ProfileDraft['groupStatus'] })}><option>UNKNOWN</option><option>STANDALONE_NO_EXEMPTION</option><option>PARENT</option><option>SUBSIDIARY</option><option>CONSOLIDATED</option><option>SECTION_264_3_EXEMPTION</option></select></label>
      <label>Beginn<input className="form-control" type="date" value={profile.fiscalPeriodStart} onChange={e => setProfile({ ...profile, fiscalPeriodStart: e.target.value })} /></label><label>Ende<input className="form-control" type="date" value={profile.fiscalPeriodEnd} onChange={e => setProfile({ ...profile, fiscalPeriodEnd: e.target.value })} /></label>
      <ExplicitBoolean label="In Deutschland registriert" value={profile.germanRegisteredEntity} onChange={value => setProfile({ ...profile, germanRegisteredEntity: value })} />
      <ExplicitBoolean label="Unternehmen von öffentlichem Interesse" value={profile.publicInterestEntity} onChange={value => setProfile({ ...profile, publicInterestEntity: value })} /><ExplicitBoolean label="Kapitalmarktorientiert oder börsennotiert" value={profile.capitalMarketOrListed} onChange={value => setProfile({ ...profile, capitalMarketOrListed: value })} /><ExplicitBoolean label="Regulierte Branche" value={profile.regulatedIndustry} onChange={value => setProfile({ ...profile, regulatedIndustry: value })} />
      <ExplicitBoolean label="Liquidations- oder Insolvenzbewertung" value={profile.liquidationOrInsolvencyBasis} onChange={value => setProfile({ ...profile, liquidationOrInsolvencyBasis: value })} /><ExplicitBoolean label="Unternehmensfortführung angemessen" value={profile.goingConcern} onChange={value => setProfile({ ...profile, goingConcern: value })} /><ExplicitBoolean label="Gründung oder Umwandlung im Geschäftsjahr" value={profile.formedOrConvertedInCurrentPeriod} onChange={value => setProfile({ ...profile, formedOrConvertedInCurrentPeriod: value })} /><ExplicitBoolean label="§ 5a GmbHG anwendbar" value={profile.section5aApplies} onChange={value => setProfile({ ...profile, section5aApplies: value })} />
      <ExplicitBoolean label="Vorräte vorhanden" value={profile.hasInventory} onChange={value => setProfile({ ...profile, hasInventory: value })} /><ExplicitBoolean label="Anlagevermögen vorhanden" value={profile.hasFixedAssets} onChange={value => setProfile({ ...profile, hasFixedAssets: value })} />
      <fieldset><legend>Optionale Anhangbefreiung für Kleinstkapitalgesellschaften</legend><p>Leer lassen, wenn ein Anhang erstellt wird. Die Befreiung greift nur, wenn alle drei Voraussetzungen ausdrücklich bestätigt sind.</p><ExplicitBoolean label="Angaben nach § 268 Abs. 7 unter der Bilanz" value={profile.microNotesOmission?.requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet ?? null} onChange={value => setProfile({ ...profile, microNotesOmission: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: value, advancesAndLoansToManagementDisclosedBelowBalanceSheet: profile.microNotesOmission?.advancesAndLoansToManagementDisclosedBelowBalanceSheet ?? null, requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: profile.microNotesOmission?.requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet ?? null } })} /><ExplicitBoolean label="Vorschüsse und Kredite an Geschäftsführung unter der Bilanz" value={profile.microNotesOmission?.advancesAndLoansToManagementDisclosedBelowBalanceSheet ?? null} onChange={value => setProfile({ ...profile, microNotesOmission: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: profile.microNotesOmission?.requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet ?? null, advancesAndLoansToManagementDisclosedBelowBalanceSheet: value, requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: profile.microNotesOmission?.requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet ?? null } })} /><ExplicitBoolean label="Zusätzliche Angaben für ein den tatsächlichen Verhältnissen entsprechendes Bild beurteilt" value={profile.microNotesOmission?.requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet ?? null} onChange={value => setProfile({ ...profile, microNotesOmission: { requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet: profile.microNotesOmission?.requiredSection268Paragraph7DisclosuresIncludedBelowBalanceSheet ?? null, advancesAndLoansToManagementDisclosedBelowBalanceSheet: profile.microNotesOmission?.advancesAndLoansToManagementDisclosedBelowBalanceSheet ?? null, requiredAdditionalTrueAndFairDisclosuresIncludedBelowBalanceSheet: value } })} /></fieldset>
      <SizeFacts title="Aktuelles Geschäftsjahr" value={profile.currentSizeFacts} onChange={currentSizeFacts => setProfile({ ...profile, currentSizeFacts })} /><SizeFacts title="Vorjahr" value={profile.priorSizeFacts!} onChange={priorSizeFacts => setProfile({ ...profile, priorSizeFacts })} />
      <label>Bisher festgestellte Größenklasse<select className="form-select" value={profile.priorEstablishedSize ?? ''} onChange={e => setProfile({ ...profile, priorEstablishedSize: e.target.value as ProfileDraft['priorEstablishedSize'] || undefined })}><option value="">Nicht beantwortet</option><option>MICRO</option><option>SMALL</option></select></label>
      <p>Diese Abschlussmerkmale werden beim Speichern des Arbeitspapiers „Größenklasse und Anwendungsbereich“ unveränderlich mit dessen Nachweisen und unabhängiger Prüfung verbunden. Stammdaten und Registerangaben werden in den Unternehmenseinstellungen gepflegt.</p>
    </div></details>
    <details open><summary><strong>2. Arbeitspapiere und Bewertung</strong></summary><div className="mt-3"><label>Arbeitspapier<select className="form-select" value={selectedKind} onChange={e => choose(e.target.value as HgbWorkpaperKind)}>{kinds.map(kind => <option key={kind} value={kind}>{titles[kind]} · {collection?.workpapers.find(item => item.kind === kind)?.status ?? 'FEHLT'}</option>)}</select></label>
      <StructuredFields value={draft as unknown as Record<string, unknown>} onChange={next => setDraft(next as unknown as HgbWorkpaperDraft)} />
      <div className="action-stack"><button className="btn btn-primary" disabled={busy || collection?.fiscalPeriod.status !== 'OPEN' || selectedKind === 'SIZE_AND_APPLICABILITY' && !profileIsExplicit(profile)} onClick={() => perform(async () => { const candidate = selectedKind === 'SIZE_AND_APPLICABILITY' ? { ...draft, schedule: { ...draft.schedule, closeProfile: profile as HgbCloseProfile } } as HgbWorkpaperDraft : draft; await api.saveWorkpaper(year, candidate, selected?.status === 'DRAFT' ? selected.checksum : undefined, tenantId) })}>Entwurf speichern</button>{selected && <WorkpaperActions year={year} tenantId={tenantId} record={selected} busy={busy} perform={perform} api={api} />}</div>
    </div></details>
    <details><summary><strong>3. Unterschriften, Feststellung und Abschlusslauf</strong></summary><div className="hgb-fields mt-3"><label>Freigegebener Jahresabschluss<select className="form-select" value={annualPackageId} onChange={e => setAnnualPackageId(e.target.value)}><option value="">Nicht ausgewählt</option>{overview?.approvedAnnualPackages.map(item => <option key={item.id} value={item.id}>Version {item.version} · {item.id}</option>)}</select></label><label>Vertreter-IDs<input className="form-control" value={representatives} onChange={e => setRepresentatives(e.target.value)} placeholder="Kommagetrennt" /></label><label>Unterschriftnachweis-IDs<input className="form-control" value={signatureEvidence} onChange={e => setSignatureEvidence(e.target.value)} placeholder="In gleicher Reihenfolge" /></label><label>Unterzeichnet am<input className="form-control" type="datetime-local" value={signedAt} onChange={e => setSignedAt(e.target.value)} /></label><label>Gesellschafterbeschluss-ID<input className="form-control" value={resolutionId} onChange={e => setResolutionId(e.target.value)} /></label><label>Grund des Abschlusslaufs<input className="form-control" value={reason} onChange={e => setReason(e.target.value)} /></label>
      <button className="btn btn-primary" disabled={busy || !reason.trim() || !annualPackageId} onClick={() => { const annualPackage = overview?.approvedAnnualPackages.find(item => item.id === annualPackageId); return perform(() => api.evaluate(year, evaluationInput(representatives, signatureEvidence, signedAt, resolutionId, reason, annualPackage), tenantId)) }}>HGB-Abschlusslauf auswerten</button></div></details>
  </section>
}

function SizeFacts({ title, value, onChange }: { title: string; value: HgbCloseProfile['currentSizeFacts']; onChange: (value: HgbCloseProfile['currentSizeFacts']) => void }) {
  const employees = [...value.quarterlyEmployeeCounts] as [number, number, number, number]
  return <fieldset><legend>{title}</legend><label>Bilanzsumme (Cent)<input className="form-control" type="number" value={value.balanceSheetTotalCents} onChange={e => onChange({ ...value, balanceSheetTotalCents: Number(e.target.value) })} /></label><label>Umsatzerlöse (Cent)<input className="form-control" type="number" value={value.revenueCents} onChange={e => onChange({ ...value, revenueCents: Number(e.target.value) })} /></label>{employees.map((count, index) => <label key={index}>Beschäftigte Quartal {index + 1}<input className="form-control" type="number" value={count} onChange={e => { const next = [...employees] as typeof employees; next[index] = Number(e.target.value); onChange({ ...value, quarterlyEmployeeCounts: next }) }} /></label>)}<label className="form-check"><input className="form-check-input" type="checkbox" checked={value.microExcludedBySection267a} onChange={e => onChange({ ...value, microExcludedBySection267a: e.target.checked })} />Ausschluss nach § 267a Abs. 3 HGB</label></fieldset>
}

function WorkpaperActions({ year, tenantId, record, busy, perform, api }: { year: number; tenantId?: string; record: HgbWorkpaperRecordView; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; api: HgbCloseApi }) {
  const [reviewReason, setReviewReason] = useState('')
  const buttons: ReactNode[] = []
  if (record.status === 'DRAFT' || record.status === 'REJECTED') buttons.push(<button key="prepare" className="btn btn-outline-secondary" disabled={busy} onClick={() => perform(() => api.prepareWorkpaper(year, record, tenantId))}>Als erstellt kennzeichnen</button>)
  if (record.status === 'PREPARED') buttons.push(<label key="reason">Prüfvermerk<input className="form-control" value={reviewReason} onChange={e => setReviewReason(e.target.value)} /></label>, <button key="approve" className="btn btn-outline-secondary" disabled={busy} onClick={() => perform(() => api.reviewWorkpaper(year, record, 'APPROVE', reviewReason, tenantId))}>Unabhängig freigeben</button>, <button key="reject" className="btn btn-outline-secondary" disabled={busy || !reviewReason.trim()} onClick={() => perform(() => api.reviewWorkpaper(year, record, 'REJECT', reviewReason, tenantId))}>Zurückweisen</button>)
  if (record.status === 'REVIEWED') for (const adjustment of record.adjustments.filter(item => item.status !== 'POSTED')) buttons.push(<button key={adjustment.proposalId} className="btn btn-outline-secondary" disabled={busy} onClick={() => perform(() => api.postAdjustment(year, record, adjustment.proposalId, tenantId))}>Buchung {adjustment.proposalId} ausführen</button>)
  return <>{buttons}</>
}

export function evaluationInput(representativesText: string, evidenceText: string, signedAt: string, shareholderResolutionId: string, reason: string, annualPackage?: { id: string; checksum: string }) {
  const legalRepresentativeIds = representativesText.split(',').map(value => value.trim()).filter(Boolean); const evidenceIds = evidenceText.split(',').map(value => value.trim()).filter(Boolean)
  return { reason, annualAccountsPackageId: annualPackage?.id, annualAccountsChecksum: annualPackage?.checksum, legalRepresentativeIds, managingDirectorSignatures: legalRepresentativeIds.map((representativeId, index) => ({ representativeId, signedAt: signedAt ? new Date(signedAt).toISOString() : '', signatureEvidenceId: evidenceIds[index] ?? '' })), shareholderResolutionId }
}
