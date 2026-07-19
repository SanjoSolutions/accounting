import { describe, expect, it, vi } from 'vitest'
import { VatRuleBook, calculateVat, createTestVatIdValidationEvidence, createTestVatReversalStore, createTestVatRuleBook, createTestVatTransportEvidence, reconcileVat, representativeGermanVatRules } from './vatEngine'
import { DeclarationWorkflow, FormRegistry, TaxDeclarationError, annualVatDataset, cancelWithGateway, createConfiguredDeclarationWorkflowAuthenticator, createConfiguredDeclarationWorkflowStore, createConfiguredOfficialTaxGateway, createTestDeclarationWorkflowStore, createTestOfficialTaxGateway, deriveOssPeriods, deriveVatDatasets, deriveVatPeriods, extensionDatasets, finalizeAcceptedCorrection, nextBusinessDay, persistDeclarationWorkflow, persistUncertainWorkflow, recoverWithGateway, restoreDeclarationWorkflow, restoreUncertainWorkflow, submitWithGateway, taxFormRegistry, validateGermanVatId, validateWithGateway, validateZmEntries, type FilingProfile, type OfficialTaxGateway, type PersistedDeclarationWorkflow } from './taxDeclarations'

const profile: FilingProfile = { companyId: 'company-1', frequency: 'monthly', deadlineExtension: false, specialPrepayment: false, zmEnabled: false, ossEnabled: false }
const gateway = (outcome: 'accepted' | 'rejected' | 'uncertain' = 'accepted'): OfficialTaxGateway => createTestOfficialTaxGateway({
  validate: vi.fn(async () => ({ valid: true, errors: [], protocol: '<validation/>' })),
  submit: vi.fn(async () => ({ outcome, receipt: outcome === 'accepted' ? '<receipt immutable="true"/>' : undefined })),
  correct: vi.fn(async () => ({ outcome, receipt: outcome === 'accepted' ? '<correction-receipt/>' : undefined })),
  cancel: vi.fn(async () => ({ outcome, receipt: outcome === 'accepted' ? '<cancellation-receipt/>' : undefined })),
  recover: vi.fn(async (): Promise<{ outcome: 'accepted'; receipt: string }> => ({ outcome: 'accepted', receipt: '<recovered/>' })),
})
const workflowAuthenticator = (configurationId: string) => { const authenticated = new Map<string, string>(); let sequence = 0; return createConfiguredDeclarationWorkflowAuthenticator({ authenticate: payload => { const tag = `opaque-signature-${++sequence}`; authenticated.set(tag, payload); return tag }, verify: (payload, tag) => authenticated.get(tag) === payload }, configurationId) }

describe('versioned VAT declaration workflow', () => {
  it('derives monthly, quarterly and exempt periods and profile-driven deadlines', () => {
    const monthly = deriveVatPeriods(2026, profile)
    expect(monthly).toHaveLength(12)
    expect(monthly[0]).toEqual({ key: '2026-01', from: '2026-01-01', to: '2026-01-31', dueDate: '2026-02-10' })
    const quarterly = deriveVatPeriods(2026, { ...profile, frequency: 'quarterly', deadlineExtension: true })
    expect(quarterly).toHaveLength(4)
    expect(quarterly[3]).toEqual({ key: '2026-Q4', from: '2026-10-01', to: '2026-12-31', dueDate: '2027-02-10' })
    expect(deriveVatPeriods(2026, { ...profile, frequency: 'exempt' })).toEqual([])
    expect(() => deriveVatPeriods(2026, { ...profile, frequency: 'weekly' as never }, new Set())).toThrow(/supported canonical discriminant/)
    expect(deriveOssPeriods(2026, true).map(period => period.key)).toEqual(['2026-Q1', '2026-Q2', '2026-Q3', '2026-Q4'])
    expect(deriveOssPeriods(2026, true)[0].dueDate).toBe('2026-04-30')
    expect(deriveOssPeriods(2026, true)[2].dueDate).toBe('2026-10-31')
    expect(() => deriveVatPeriods(Number.POSITIVE_INFINITY, profile)).toThrow(/safe four-digit calendar years/)
    expect(() => deriveVatPeriods(999, profile, new Set())).toThrow(/safe four-digit calendar year/)
    expect(() => deriveOssPeriods(Number.MAX_SAFE_INTEGER, true)).toThrow(/safe four-digit calendar years/)
    expect(() => deriveOssPeriods(Number.MAX_SAFE_INTEGER, true, new Set())).toThrow(/safe four-digit calendar year/)
  })

  it('versions official schemas, rejects unsupported periods and prepares extension/prepayment forms', () => {
    expect(taxFormRegistry.resolve('USTVA', '2026-01').version).toBe('USTVA-2026.1')
    expect(() => taxFormRegistry.resolve('USTVA', '2025-12')).toThrow(/Unsupported USTVA period/)
    expect(() => taxFormRegistry.resolve('USTVA', '2026-13')).toThrow(/Invalid USTVA filing period/)
    expect(() => taxFormRegistry.resolve('KST', '2026-Q1')).toThrow(/Invalid KST filing period/)
    expect(() => taxFormRegistry.resolve('OSS', '2026-01')).toThrow(/Invalid OSS filing period/)
    expect(() => extensionDatasets(2026, { ...profile, deadlineExtension: true, specialPrepayment: true }, taxFormRegistry)).toThrow(/Prior-year/)
    const forms = extensionDatasets(2026, { ...profile, deadlineExtension: true, specialPrepayment: true }, taxFormRegistry, 110_000)
    expect(forms.map(form => form.kind)).toEqual(['DAUERFRISTVERLAENGERUNG', 'SONDERVORAUSZAHLUNG'])
    expect(forms[1].fields.ZAHLLAST).toBe(10_000)
    expect(extensionDatasets(2026, { ...profile, deadlineExtension: true, specialPrepayment: true }, taxFormRegistry, 110_100)[1].fields.ZAHLLAST).toBe(10_000)
    expect(() => extensionDatasets(2026, { ...profile, deadlineExtension: true, specialPrepayment: true }, taxFormRegistry, Number.MAX_SAFE_INTEGER + 1)).toThrow(/safe-integer cents/)
    expect(extensionDatasets(2026, { ...profile, deadlineExtension: true, specialPrepayment: true }, taxFormRegistry, -110_000)[1].fields.ZAHLLAST).toBe(0)
    expect(() => extensionDatasets(2026, { ...profile, deadlineExtension: false, specialPrepayment: true }, taxFormRegistry, 110_000)).toThrow(/requires an active deadline extension/)
    expect(() => extensionDatasets(2026, { ...profile, frequency: 'quarterly', deadlineExtension: true, specialPrepayment: true }, taxFormRegistry, 110_000)).toThrow(/only applicable to monthly/)
    expect(extensionDatasets(2026, { ...profile, frequency: 'exempt', deadlineExtension: true }, taxFormRegistry)).toEqual([])
    expect(() => extensionDatasets(2026, { ...profile, frequency: 'exempt', deadlineExtension: true, specialPrepayment: true }, taxFormRegistry, 110_000)).toThrow(/VAT-exempt profiles/)
    expect(() => extensionDatasets(2026, { ...profile, frequency: 'weekly' as never }, taxFormRegistry)).toThrow(/supported canonical discriminant/)
  })

  it('derives UStVA, annual VAT, conditional ZM/OSS and preserves box drilldown', () => {
    const rules = createTestVatRuleBook(representativeGermanVatRules)
    const ownerId = 'company-1'
    const reversalRegistry = createTestVatReversalStore(ownerId)
    const transportEvidence = createTestVatTransportEvidence({ ownerId: profile.companyId, type: 'carrier-document', reference: 'CMR-1', dispatchedFromCountry: 'DE', destinationCountry: 'FR', sourceId: 'eu-sale' })
    const customerVatIdValidation = createTestVatIdValidationEvidence('FR12345678901', 'FR')
    const details = [
      calculateVat({ ownerId, sourceId: 'sale', amountCents: 10_000, mode: 'net', taxPoint: '2026-01-02', ruleId: 'DE_STANDARD' }, rules, undefined, reversalRegistry),
      calculateVat({ ownerId, sourceId: 'eu-sale', amountCents: 10_000, mode: 'net', taxPoint: '2026-01-03', ruleId: 'EU_SUPPLY', direction: 'sale', customerType: 'business', customerVatId: 'FR12345678901', customerVatIdValidation, customerCountry: 'FR', supplyKind: 'goods', transportEvidence }, rules, undefined, reversalRegistry),
      calculateVat({ ownerId, sourceId: 'oss-sale', amountCents: 10_000, mode: 'net', taxPoint: '2026-01-03', ruleId: 'OSS_FR_STANDARD', direction: 'sale', customerType: 'consumer', customerCountry: 'FR' }, rules, undefined, reversalRegistry),
    ]
    const reconciliation = reconcileVat(details, { outputTaxCents: 3_900, inputTaxCents: 0 })
    const tolerated = reconcileVat(details, { outputTaxCents: 3_901, inputTaxCents: 0 }, 1)
    const quarter = { key: '2026-Q1', from: '2026-01-01', to: '2026-03-31', dueDate: '2026-04-10' }
    const januaryZm = deriveVatPeriods(2026, profile)[0]
    const datasets = deriveVatDatasets(quarter, { ...profile, frequency: 'quarterly', zmEnabled: true, ossEnabled: true }, details, reconciliation, taxFormRegistry, quarter, reconciliation, januaryZm)
    expect(() => deriveVatDatasets(quarter, { ...profile, frequency: 'quarterly' }, details, tolerated, taxFormRegistry)).toThrow(/exact zero-tolerance/)
    expect(datasets.map(item => item.kind)).toEqual(['USTVA', 'ZM', 'OSS'])
    expect(datasets[0].drilldown.KZ81).toContain('sale')
    expect(datasets[0].fields.KZ81).toBe(10_000)
    expect(datasets[0].fields.ZAHLLAST).toBe(1_900)
    expect(datasets[0].fields.KZ83).toBe(1_900)
    expect(datasets[1]).toMatchObject({ fields: { SUMME: 10_000, USTID_OK: true }, drilldown: { SUMME: ['eu-sale'] } })
    expect(datasets[1].period).toBe('2026-01')
    expect(datasets[2].fields.LAND_FR_SATZ_2000).toBe(10_000)
    expect(datasets[2].fields.LAND_FR_SATZ_2000_STEUER).toBe(2_000)
    expect(datasets[2].fields.STEUER).toBe(2_000)
    expect(() => deriveVatDatasets(januaryZm, { ...profile, zmEnabled: true }, details, reconciliation, taxFormRegistry, undefined, undefined, deriveVatPeriods(2026, profile)[1])).toThrow(/ZM periods must uniquely account for every supplied eligible/)
    const q2 = deriveOssPeriods(2026, true)[1]; const emptyQ2Reconciliation = reconcileVat([], { outputTaxCents: 0, inputTaxCents: 0 }, 0, ownerId)
    expect(() => deriveVatDatasets(januaryZm, { ...profile, ossEnabled: true }, [details[0], details[2]], reconciliation, taxFormRegistry, q2, emptyQ2Reconciliation)).toThrow(/OSS quarter must cover.*every supplied OSS sale/)
    const februaryEu = calculateVat({ ownerId, sourceId: 'feb-eu-sale', amountCents: 1_000, mode: 'net', taxPoint: '2026-02-03', ruleId: 'EU_SUPPLY', direction: 'sale', customerType: 'business', customerVatId: 'FR12345678901', customerVatIdValidation, customerCountry: 'FR', supplyKind: 'goods', transportEvidence: createTestVatTransportEvidence({ ownerId, type: 'carrier-document', reference: 'CMR-Feb', dispatchedFromCountry: 'DE', destinationCountry: 'FR', sourceId: 'feb-eu-sale' }) }, rules)
    const multiMonthZmDetails = [details[0], details[1], februaryEu]; const multiMonthZm = deriveVatDatasets(quarter, { ...profile, frequency: 'quarterly', zmEnabled: true }, multiMonthZmDetails, reconcileVat(multiMonthZmDetails, { outputTaxCents: 1_900, inputTaxCents: 0 }), taxFormRegistry, undefined, undefined, [januaryZm, deriveVatPeriods(2026, profile)[1]]).filter(item => item.kind === 'ZM')
    expect(multiMonthZm.map(item => item.period)).toEqual(['2026-01', '2026-02']); expect(multiMonthZm.map(item => item.fields.SUMME)).toEqual([10_000, 1_000])
    const januaryStandard = [details[0]]; const primaryJanuaryReconciliation = reconcileVat(januaryStandard, { outputTaxCents: 1_900, inputTaxCents: 0 })
    expect(() => deriveVatDatasets(deriveVatPeriods(2026, profile)[0], { ...profile, zmEnabled: true }, [...januaryStandard, februaryEu, februaryEu], primaryJanuaryReconciliation, taxFormRegistry, undefined, undefined, deriveVatPeriods(2026, profile)[1])).toThrow(/independent ZM period requires unique/)
    const euCredit = calculateVat({ ...details[1], sourceId: 'eu-credit', amountCents: 10_000, reversalOf: 'eu-sale', originalTaxPoint: details[1].taxPoint }, rules, details[1], reversalRegistry)
    const netted = deriveVatDatasets(quarter, { ...profile, frequency: 'quarterly', zmEnabled: true }, [details[1], euCredit], reconcileVat([details[1], euCredit], { outputTaxCents: 0, inputTaxCents: 0 }), taxFormRegistry, undefined, undefined, januaryZm)
    expect(netted.find(item => item.kind === 'ZM')?.fields.SUMME).toBe(0)
    const ossCredit = calculateVat({ ...details[2], sourceId: 'oss-credit', amountCents: 10_000, reversalOf: 'oss-sale', originalTaxPoint: details[2].taxPoint }, rules, details[2], reversalRegistry)
    const creditOssReconciliation = reconcileVat([ossCredit], { outputTaxCents: -2_000, inputTaxCents: 0 })
    const creditOss = deriveVatDatasets(quarter, { ...profile, frequency: 'quarterly', ossEnabled: true }, [ossCredit], creditOssReconciliation, taxFormRegistry, quarter, creditOssReconciliation).find(item => item.kind === 'OSS')
    expect(creditOss?.fields).toMatchObject({ LAND_FR_SATZ_2000: -10_000, LAND_FR_SATZ_2000_STEUER: -2_000, STEUER: -2_000 })
    const smallOss = ['small-1', 'small-2'].map(sourceId => calculateVat({ ownerId, sourceId, amountCents: 3, mode: 'net', taxPoint: '2026-01-04', ruleId: 'OSS_FR_STANDARD', direction: 'sale', customerType: 'consumer', customerCountry: 'FR' }, rules))
    const smallOssReconciliation = reconcileVat(smallOss, { outputTaxCents: 2, inputTaxCents: 0 })
    const smallOssDataset = deriveVatDatasets(quarter, { ...profile, frequency: 'quarterly', ossEnabled: true }, smallOss, smallOssReconciliation, taxFormRegistry, quarter, smallOssReconciliation).find(item => item.kind === 'OSS')
    expect(smallOssDataset?.fields).toMatchObject({ LAND_FR_SATZ_2000: 6, LAND_FR_SATZ_2000_STEUER: 2, STEUER: 2 })
    const spellingVariant = calculateVat({ ...details[1], sourceId: 'eu-sale-variant', customerVatId: 'FR 12 345 678 901', customerVatIdValidation: createTestVatIdValidationEvidence('FR 12 345 678 901', 'FR'), transportEvidence: createTestVatTransportEvidence({ ownerId: profile.companyId, type: 'carrier-document', reference: 'CMR-variant', dispatchedFromCountry: 'DE', destinationCountry: 'FR', sourceId: 'eu-sale-variant' }) }, rules)
    const normalizedZm = deriveVatDatasets(quarter, { ...profile, frequency: 'quarterly', zmEnabled: true }, [details[1], spellingVariant], reconcileVat([details[1], spellingVariant], { outputTaxCents: 0, inputTaxCents: 0 }), taxFormRegistry, undefined, undefined, januaryZm).find(item => item.kind === 'ZM')
    expect(normalizedZm?.fields.SUMME).toBe(20_000)
    expect(JSON.parse(String(normalizedZm?.fields.MELDUNGEN))).toHaveLength(1)
    const euService = calculateVat({ ownerId, sourceId: 'eu-service', amountCents: 5_000, mode: 'net', taxPoint: '2026-01-04', ruleId: 'EU_SERVICE', direction: 'sale', customerType: 'business', customerVatId: 'FR12345678901', customerVatIdValidation: createTestVatIdValidationEvidence('FR12345678901', 'FR'), customerCountry: 'FR', supplyKind: 'services' }, rules)
    const serviceZm = deriveVatDatasets(januaryZm, { ...profile, zmEnabled: true }, [euService], reconcileVat([euService], { outputTaxCents: 0, inputTaxCents: 0 }), taxFormRegistry, undefined, undefined, januaryZm).find(item => item.kind === 'ZM')
    expect(JSON.parse(String(serviceZm?.fields.MELDUNGEN))).toEqual([{ customerVatId: 'FR12345678901', supplyKind: 'services', amountCents: 5_000 }])
    const februaryOss = calculateVat({ ...details[2], sourceId: 'oss-february', taxPoint: '2026-02-03' }, rules)
    const januaryDetails = [details[0], februaryOss]; const januaryReconciliation = reconcileVat([details[0]], { outputTaxCents: 1_900, inputTaxCents: 0 }); const quarterReconciliation = reconcileVat(januaryDetails, { outputTaxCents: 3_900, inputTaxCents: 0 })
    expect(deriveVatDatasets(deriveVatPeriods(2026, profile)[0], { ...profile, ossEnabled: true }, januaryDetails, januaryReconciliation, taxFormRegistry, quarter, quarterReconciliation).find(item => item.kind === 'OSS')?.fields.STEUER).toBe(2_000)
    expect(() => deriveVatDatasets(deriveVatPeriods(2026, profile)[0], { ...profile, ossEnabled: true }, [details[0], { ...februaryOss }], januaryReconciliation, taxFormRegistry, quarter, quarterReconciliation)).toThrow(/trusted calculated posting/)
    const annual = annualVatDataset(2026, details, reconciliation, taxFormRegistry, profile.companyId)
    expect(annual.kind).toBe('UST_ANNUAL'); expect(annual.fields.ZAHLLAST).toBe(1_900)
    expect(() => deriveVatDatasets(quarter, { ...profile, frequency: 'quarterly', zmEnabled: true }, details, reconciliation, taxFormRegistry)).toThrow(/separate canonical ZM filing period/)
    const forgedFebruaryZm = { ...details[1], sourceId: 'forged-february-zm', taxPoint: '2026-02-03', netBaseCents: 999_999 }
    expect(() => deriveVatDatasets(januaryZm, { ...profile, zmEnabled: true }, [details[0], forgedFebruaryZm], reconcileVat([details[0]], { outputTaxCents: 1_900, inputTaxCents: 0 }), taxFormRegistry, undefined, undefined, quarter)).toThrow(/exact trusted calculated postings/)
    const otherOwnerService = calculateVat({ ownerId: 'other-company', sourceId: 'other-owner-service', amountCents: 5_000, mode: 'net', taxPoint: '2026-02-03', ruleId: 'EU_SERVICE', direction: 'sale', customerType: 'business', customerVatId: 'FR12345678901', customerVatIdValidation: createTestVatIdValidationEvidence('FR12345678901', 'FR'), customerCountry: 'FR', supplyKind: 'services' }, rules)
    expect(() => deriveVatDatasets(januaryZm, { ...profile, zmEnabled: true }, [details[0], otherOwnerService], reconcileVat([details[0]], { outputTaxCents: 1_900, inputTaxCents: 0 }), taxFormRegistry, undefined, undefined, quarter)).toThrow(/filing-profile taxpayer/)
    expect(() => deriveVatDatasets(deriveVatPeriods(2026, profile)[0], { ...profile, zmEnabled: true, ossEnabled: true }, details, reconciliation, taxFormRegistry, undefined, undefined, januaryZm)).toThrow(/separate canonical quarterly OSS period/)
    expect(() => deriveVatDatasets(quarter, { ...profile, frequency: 'quarterly', ossEnabled: true }, details, reconciliation, taxFormRegistry, quarter)).toThrow(/ZM filing obligation/)
    expect(() => deriveVatDatasets(quarter, { ...profile, frequency: 'monthly', zmEnabled: true, ossEnabled: true }, details, reconciliation, taxFormRegistry, quarter)).toThrow(/filing cadence/)
    expect(() => deriveVatDatasets(deriveVatPeriods(2026, profile)[0], { ...profile, frequency: 'quarterly' }, [details[0]], reconcileVat([details[0]], { outputTaxCents: 1_900, inputTaxCents: 0 }), taxFormRegistry)).toThrow(/filing cadence/)
    expect(() => deriveVatDatasets(deriveVatPeriods(2026, profile)[0], { ...profile, frequency: 'exempt' }, [details[0]], reconcileVat([details[0]], { outputTaxCents: 1_900, inputTaxCents: 0 }), taxFormRegistry)).toThrow(/VAT-exempt/)
    expect(() => deriveVatDatasets(deriveVatPeriods(2026, profile)[0], { ...profile, frequency: 'weekly' as never }, [details[0]], reconcileVat([details[0]], { outputTaxCents: 1_900, inputTaxCents: 0 }), taxFormRegistry)).toThrow(/supported canonical discriminant/)
    const emptyReconciliation = reconcileVat([], { outputTaxCents: 0, inputTaxCents: 0 }, 0, profile.companyId)
    expect(deriveVatDatasets(deriveVatPeriods(2026, profile)[1], profile, [], emptyReconciliation, taxFormRegistry)[0].fields.ZAHLLAST).toBe(0)
    const december = deriveVatPeriods(2026, profile)[11]
    expect(() => deriveVatDatasets(december, { ...profile, deadlineExtension: true, specialPrepayment: true }, [], emptyReconciliation, taxFormRegistry)).toThrow(/actual.*Sondervorauszahlung/)
    expect(deriveVatDatasets(december, { ...profile, deadlineExtension: true, specialPrepayment: true }, [], emptyReconciliation, taxFormRegistry, undefined, undefined, undefined, { amountCents: 10_000, sourceId: 'special-prepayment-2026' })[0]).toMatchObject({ fields: { KZ39: 10_000, KZ83: -10_000, ZAHLLAST: -10_000 }, drilldown: { KZ39: ['special-prepayment-2026'], KZ83: ['special-prepayment-2026'] } })
    expect(() => deriveVatDatasets(deriveVatPeriods(2026, profile)[1], { ...profile, ossEnabled: true }, [], emptyReconciliation, taxFormRegistry)).toThrow(/Enabled OSS filing requires/)
    const nilOss = deriveVatDatasets(deriveVatPeriods(2026, profile)[1], { ...profile, ossEnabled: true }, [], emptyReconciliation, taxFormRegistry, quarter, emptyReconciliation).find(item => item.kind === 'OSS')
    expect(nilOss?.fields).toMatchObject({ UMSATZ: 0, STEUER: 0 })
    expect(annualVatDataset(2026, [], emptyReconciliation, taxFormRegistry, profile.companyId).fields.ZAHLLAST).toBe(0)
  })

  it('validates VAT IDs and ZM customer entries with required drilldown', () => {
    expect(validateGermanVatId('DE 123 456 789')).toBe(true)
    expect(validateGermanVatId('FR123')).toBe(false)
    const frEvidence = createTestVatIdValidationEvidence('FR12345678901', 'FR'); const xiEvidence = createTestVatIdValidationEvidence('XI123456789', 'XI')
    expect(() => validateZmEntries([{ customerVatId: 'FR12345678901', validationEvidence: frEvidence, supplyKind: 'goods', amountCents: 100, sourceIds: ['entry'] }])).not.toThrow()
    expect(() => validateZmEntries([{ customerVatId: 'FR12345678901', validationEvidence: frEvidence, supplyKind: 'goods', amountCents: -100, sourceIds: ['credit'] }])).not.toThrow()
    expect(() => validateZmEntries([{ customerVatId: 'XI123456789', validationEvidence: xiEvidence, supplyKind: 'goods', amountCents: 100, sourceIds: ['entry'] }])).not.toThrow()
    expect(() => validateZmEntries([{ customerVatId: 'XI123456789', validationEvidence: xiEvidence, supplyKind: 'services', amountCents: 100, sourceIds: ['entry'] }])).toThrow(/supply kind|authoritatively validated/)
    expect(() => validateZmEntries([{ customerVatId: 'FR12345678901', validationEvidence: { ...frEvidence }, supplyKind: 'goods', amountCents: 100, sourceIds: ['entry'] }])).toThrow(/not been authoritatively validated/)
    expect(() => validateZmEntries([{ customerVatId: 'FR12345678901', validationEvidence: frEvidence, supplyKind: 'goods', amountCents: 100, sourceIds: [' '] }])).toThrow(/unique nonblank drilldown/)
    expect(() => validateZmEntries([{ customerVatId: 'FR12345678901', validationEvidence: frEvidence, supplyKind: 'goods', amountCents: 100, sourceIds: ['entry', 'entry'] }])).toThrow(/unique nonblank drilldown/)
    expect(() => validateZmEntries([{ customerVatId: 'DE123456789', validationEvidence: frEvidence, supplyKind: 'goods', amountCents: 100, sourceIds: [] }])).toThrow(/invalid non-German EU VAT ID/)
  })

  it('requires official validation and explicit approval before idempotent submission', async () => {
    const dataset = taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1_900 }, {}, profile.companyId)
    const submitSpy = vi.fn(async () => ({ outcome: 'accepted' as const, receipt: '<receipt immutable="true"/>' })); const official = createTestOfficialTaxGateway({ ...gateway(), submit: submitSpy })
    const draft = DeclarationWorkflow.create(dataset, '2026-02-01T00:00:00Z')
    expect(() => draft.approved('tax-user')).toThrow(/while declaration is draft/)
    const contradictoryGateway = createTestOfficialTaxGateway({ ...gateway(), validate: vi.fn(async () => ({ valid: true, errors: ['ERIC rejected field KZ83'] })) })
    await expect(validateWithGateway(DeclarationWorkflow.create(dataset), contradictoryGateway)).rejects.toThrow(/ERIC rejected field KZ83/)
    const validated = await validateWithGateway(draft, official)
    expect(() => validated.approved('')).toThrow(/approving actor/)
    expect(() => validated.approved('tax-user', '2026-02-02T00:00:00Z')).toThrow(/no earlier than the preceding event/)
    const approved = validated.approved('tax-user')
    const accepted = await submitWithGateway(approved, official)
    expect(accepted.state).toBe('accepted')
    expect(accepted.receipt).toBe('<receipt immutable="true"/>')
    expect(accepted.idempotencyKey).toMatch(/^[a-f0-9]{64}$/)
    expect(await submitWithGateway(accepted, official)).toBe(accepted)
    expect(submitSpy).toHaveBeenCalledTimes(1)
    expect(Object.isFrozen(accepted.events)).toBe(true)
  })

  it('recovers uncertain outcomes and creates linked immutable corrections/cancellations', async () => {
    const dataset = taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1_900 }, {}, profile.companyId)
    const uncertainGateway = createTestOfficialTaxGateway({ ...gateway('uncertain'), correct: vi.fn(async () => ({ outcome: 'accepted' as const, receipt: '<correction-receipt/>' })) })
    const approved = (await validateWithGateway(DeclarationWorkflow.create(dataset), uncertainGateway)).approved('tax-user')
    const uncertain = await submitWithGateway(approved, uncertainGateway)
    expect(uncertain.state).toBe('uncertain')
    const accepted = await recoverWithGateway(uncertain, uncertainGateway)
    expect(accepted).toMatchObject({ state: 'accepted', receipt: '<recovered/>' })
    const { original, correction } = accepted.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1_800 }, {}, profile.companyId))
    expect(original.state).toBe('accepted')
    expect(correction.correctsId).toBe(accepted.submissionId)
    expect(() => accepted.correction(taxFormRegistry.prepare('USTVA', '2026-02', { ZAHLLAST: 1_800 }, {}, profile.companyId))).toThrow(/same kind, period and taxpayer/)
    expect(() => accepted.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1_800 }, {}, 'other-taxpayer'))).toThrow(/same kind, period and taxpayer/)
    await expect(finalizeAcceptedCorrection(original, correction, uncertainGateway.workflowStore)).rejects.toThrow(/exact accepted linked workflows/)
    const acceptedCorrection = await submitWithGateway((await validateWithGateway(correction, uncertainGateway)).approved('tax-user'), uncertainGateway)
    expect(() => acceptedCorrection.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1_700 }, {}, profile.companyId))).toThrow(/actionable officially accepted/)
    await expect(cancelWithGateway(acceptedCorrection, 'tax-user', uncertainGateway)).rejects.toThrow(/actionable officially accepted/)
    const forgedCorrection = Object.assign(Object.create(Object.getPrototypeOf(acceptedCorrection)) as object, acceptedCorrection) as DeclarationWorkflow
    const forgedOriginal = Object.assign(Object.create(Object.getPrototypeOf(original)) as object, original) as DeclarationWorkflow
    await expect(finalizeAcceptedCorrection(original, forgedCorrection, uncertainGateway.workflowStore)).rejects.toThrow(/exact accepted linked workflows/)
    await expect(finalizeAcceptedCorrection(forgedOriginal, acceptedCorrection, uncertainGateway.workflowStore)).rejects.toThrow(/exact accepted linked workflows/)
    await expect(finalizeAcceptedCorrection(original, acceptedCorrection, createTestDeclarationWorkflowStore())).rejects.toThrow(/store bound to both accepted workflows/)
    expect((await finalizeAcceptedCorrection(original, acceptedCorrection, uncertainGateway.workflowStore)).state).toBe('corrected')
    expect(() => acceptedCorrection.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1_700 }, {}, profile.companyId))).not.toThrow()
    expect(() => original.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1_700 }, {}, profile.companyId))).toThrow(/actionable officially accepted/)
    const cancellationGateway = gateway(); const cancellable = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), cancellationGateway)).approved('tax-user'), cancellationGateway)
    await expect(cancelWithGateway(cancellable, '', cancellationGateway)).rejects.toThrow(/cancelling actor/)
    expect(await cancelWithGateway(cancellable, 'tax-user', cancellationGateway)).toMatchObject({ state: 'cancelled', idempotencyKey: `cancel:${cancellable.submissionId}` })
    await expect(cancelWithGateway(cancellable, 'tax-user', cancellationGateway)).rejects.toThrow(/actionable officially accepted/)
  })

  it('persists and integrity-checks uncertain workflows for restart recovery', async () => {
    let record: PersistedDeclarationWorkflow | undefined; let latestRevision: number | undefined
    const commit = (value: PersistedDeclarationWorkflow) => { if (value.revision < (latestRevision ?? 0)) return false; record = structuredClone(value); latestRevision = value.revision; return true }
    const store = createConfiguredDeclarationWorkflowStore({ save: commit, saveWithActionReservation: commit, saveWithActionRelease: commit, load: submissionId => record?.snapshot.submissionId === submissionId ? structuredClone(record) : undefined, loadRevision: () => latestRevision, remove: () => { record = undefined }, removeWithActionRelease: () => { record = undefined }, reserveAction: () => true, releaseAction: () => undefined }, workflowAuthenticator('workflow-hsm'), 'durable-workflow-db')
    const official = createConfiguredOfficialTaxGateway({ ...gateway('uncertain') }, 'durable-workflow-gateway', store); const dataset = taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId)
    const uncertain = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), official)).approved('actor'), official)
    await persistUncertainWorkflow(uncertain, store)
    const olderAuthenticatedRecord = structuredClone(record!)
    await expect(persistUncertainWorkflow(uncertain, createTestDeclarationWorkflowStore())).rejects.toThrow(/bound to this durable store/)
    const restored = await restoreUncertainWorkflow(uncertain.submissionId, store)
    expect(restored).not.toBe(uncertain); expect(restored).toMatchObject({ state: 'uncertain', submissionId: uncertain.submissionId, gatewayId: official.gatewayId, idempotencyKey: uncertain.idempotencyKey })
    await expect(recoverWithGateway(restored, official)).resolves.toMatchObject({ state: 'accepted', receipt: '<recovered/>' })
    const currentAuthenticatedRecord = structuredClone(record!)
    record = olderAuthenticatedRecord
    await expect(restoreDeclarationWorkflow(uncertain.submissionId, store)).rejects.toThrow(/revision is stale or has been rolled back/)
    record = currentAuthenticatedRecord
    record = { ...record!, snapshot: { ...record!.snapshot, idempotencyKey: 'forged' } }
    await expect(restoreUncertainWorkflow(uncertain.submissionId, store)).rejects.toThrow(/integrity check/)
    const cyclicSnapshot: Record<string, unknown> = { submissionId: uncertain.submissionId }; cyclicSnapshot.loop = cyclicSnapshot
    record = { version: 1, snapshot: cyclicSnapshot, authenticationTag: 'forged' } as never
    await expect(restoreUncertainWorkflow(uncertain.submissionId, store)).rejects.toThrow(/integrity check/)
    await expect(restoreUncertainWorkflow(uncertain.submissionId, { ...store } as never)).rejects.toThrow(/exact configured store/)
  })

  it('durably records an in-flight submission before the official side effect', async () => {
    const store = createTestDeclarationWorkflowStore(); const dataset = taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId); const draft = DeclarationWorkflow.create(dataset)
    const official = createConfiguredOfficialTaxGateway({ ...gateway(), submit: vi.fn(async () => { expect(await restoreDeclarationWorkflow(draft.submissionId, store)).toMatchObject({ state: 'submitting', gatewayId: 'durable-gateway' }); throw new Error('simulated process loss after gateway call') }) }, 'durable-gateway', store)
    const approved = (await validateWithGateway(draft, official)).approved('actor')
    await expect(submitWithGateway(approved, official)).rejects.toThrow(/simulated process loss/)
    const restored = await restoreDeclarationWorkflow(draft.submissionId, store)
    expect(restored).toMatchObject({ state: 'submitting', idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) })
    await expect(recoverWithGateway(restored, official)).resolves.toMatchObject({ state: 'accepted', receipt: '<recovered/>' })
  })

  it('durably records cancellation intent and revokes stale accepted instances', async () => {
    const store = createTestDeclarationWorkflowStore(); const dataset = taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId); let accepted!: DeclarationWorkflow
    const official = createConfiguredOfficialTaxGateway({ ...gateway(), cancel: vi.fn(async () => { expect(await restoreDeclarationWorkflow(accepted.submissionId, store)).toMatchObject({ state: 'cancelling', idempotencyKey: `cancel:${accepted.submissionId}` }); throw new Error('simulated cancellation response loss') }) }, 'durable-cancellation-gateway', store)
    accepted = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), official)).approved('actor'), official)
    const firstRestoredAccepted = await restoreDeclarationWorkflow(accepted.submissionId, store); const secondRestoredAccepted = await restoreDeclarationWorkflow(accepted.submissionId, store)
    await expect(cancelWithGateway(firstRestoredAccepted, 'actor', official)).rejects.toThrow(/simulated cancellation response loss/)
    expect(() => accepted.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 2 }, {}, profile.companyId))).toThrow(/actionable officially accepted/)
    const restored = await restoreDeclarationWorkflow(accepted.submissionId, store)
    await expect(recoverWithGateway(restored, official)).resolves.toMatchObject({ state: 'cancelled', receipt: '<recovered/>' })
    expect(() => secondRestoredAccepted.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 2 }, {}, profile.companyId))).toThrow(/actionable officially accepted/)
    await expect(restoreDeclarationWorkflow(accepted.submissionId, store)).resolves.toMatchObject({ state: 'cancelled', receipt: '<recovered/>', events: expect.arrayContaining([expect.objectContaining({ type: 'cancellation-accepted' })]) })
  })

  it('restores officially accepted originals and corrections after restart', async () => {
    const records = new Map<string, PersistedDeclarationWorkflow>(); const revisions = new Map<string, number>(); const reservations = new Map<string, string>(); let rejectFinalization = true; const commit = (value: PersistedDeclarationWorkflow) => { const id = value.snapshot.submissionId; if (value.revision < (revisions.get(id) ?? 0)) return false; records.set(id, structuredClone(value)); revisions.set(id, value.revision); return true }; const canReserve = (submissionId: string, actionId: string) => records.get(submissionId)?.snapshot.state === 'accepted' && (!reservations.get(submissionId) || reservations.get(submissionId) === actionId); const store = createConfiguredDeclarationWorkflowStore({ save: commit, saveWithActionReservation: (value, submissionId, actionId) => { if (!canReserve(submissionId, actionId) || !commit(value)) return false; reservations.set(submissionId, actionId); return true }, saveWithActionRelease: (value, submissionId, actionId) => { if (reservations.get(submissionId) !== actionId || rejectFinalization || !commit(value)) return false; reservations.delete(submissionId); return true }, load: submissionId => structuredClone(records.get(submissionId)), loadRevision: submissionId => revisions.get(submissionId), remove: submissionId => { records.delete(submissionId) }, removeWithActionRelease: (submissionId, targetSubmissionId, actionId) => { records.delete(submissionId); if (reservations.get(targetSubmissionId) === actionId) reservations.delete(targetSubmissionId) }, reserveAction: (submissionId, actionId) => { if (!canReserve(submissionId, actionId)) return false; reservations.set(submissionId, actionId); return true }, releaseAction: (submissionId, actionId) => { if (reservations.get(submissionId) === actionId) reservations.delete(submissionId) } }, workflowAuthenticator('accepted-workflow-hsm'), 'accepted-workflow-db')
    const official = createConfiguredOfficialTaxGateway({ ...gateway(), correct: vi.fn(async (targetSubmissionId: string) => { const pending = [...records.values()].find(value => value.snapshot.correctsId === targetSubmissionId && value.snapshot.state === 'submitting'); expect(pending).toBeDefined(); expect(reservations.get(targetSubmissionId)).toBe(`correct:${pending!.snapshot.submissionId}`); return { outcome: 'accepted' as const, receipt: '<correction-receipt/>' } }) }, 'persistent-official-gateway', store); const dataset = taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId)
    const accepted = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), official)).approved('actor'), official)
    const correction = accepted.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 2 }, {}, profile.companyId)).correction
    const acceptedCorrection = await submitWithGateway((await validateWithGateway(correction, official)).approved('actor'), official)
    await persistDeclarationWorkflow(accepted, store); await persistDeclarationWorkflow(acceptedCorrection, store)
    const restoredOriginal = await restoreDeclarationWorkflow(accepted.submissionId, store); const staleRestoredOriginal = await restoreDeclarationWorkflow(accepted.submissionId, store); const restoredCorrection = await restoreDeclarationWorkflow(acceptedCorrection.submissionId, store)
    expect(() => restoredCorrection.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 4 }, {}, profile.companyId))).toThrow(/actionable officially accepted/)
    await expect(finalizeAcceptedCorrection(restoredOriginal, restoredCorrection, store)).rejects.toThrow(/Atomic corrected-state persistence/)
    expect(reservations.get(restoredOriginal.submissionId)).toBe(`correct:${restoredCorrection.submissionId}`)
    expect(() => restoredOriginal.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 3 }, {}, profile.companyId))).not.toThrow()
    rejectFinalization = false
    expect(await finalizeAcceptedCorrection(restoredOriginal, restoredCorrection, store)).toMatchObject({ state: 'corrected' })
    expect(() => staleRestoredOriginal.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 3 }, {}, profile.companyId))).toThrow(/actionable officially accepted/)
    expect((await restoreDeclarationWorkflow(restoredOriginal.submissionId, store)).state).toBe('corrected')
    const activatedAfterRestart = await restoreDeclarationWorkflow(restoredCorrection.submissionId, store)
    expect(() => activatedAfterRestart.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 4 }, {}, profile.companyId))).not.toThrow()
  })

  it('preserves official rejection diagnostics in immutable history', async () => {
    const rejecting = createTestOfficialTaxGateway({ ...gateway(), submit: vi.fn(async () => ({ outcome: 'rejected' as const, errors: ['ERIC 610101210: invalid field'] })) })
    const approved = (await validateWithGateway(DeclarationWorkflow.create(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId)), rejecting)).approved('tax-user')
    const rejected = await submitWithGateway(approved, rejecting)
    expect(rejected.state).toBe('rejected')
    expect(rejected.events.at(-1)?.payload.errors).toEqual(['ERIC 610101210: invalid field'])
    await expect(restoreDeclarationWorkflow(rejected.submissionId, rejecting.workflowStore)).resolves.toMatchObject({ state: 'rejected', events: expect.arrayContaining([expect.objectContaining({ type: 'submission-rejected', payload: expect.objectContaining({ errors: ['ERIC 610101210: invalid field'] }) })]) })
  })

  it('rejects whitespace-only official acceptance and cancellation receipts', async () => {
    const dataset = taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId)
    const blankSubmission = createTestOfficialTaxGateway({ ...gateway(), submit: vi.fn(async () => ({ outcome: 'accepted' as const, receipt: '   ' })) })
    await expect(submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), blankSubmission)).approved('actor'), blankSubmission)).rejects.toThrow(/nonblank immutable official receipt/)
    const blankCancellation = createTestOfficialTaxGateway({ ...gateway(), cancel: vi.fn(async () => ({ outcome: 'accepted' as const, receipt: '\t' })) })
    const accepted = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), blankCancellation)).approved('actor'), blankCancellation)
    await expect(cancelWithGateway(accepted, 'actor', blankCancellation)).rejects.toThrow(/nonblank official cancellation receipt/)
  })

  it('moves deadlines over weekends/holidays and rejects impossible calendar dates', () => {
    expect(nextBusinessDay('2026-05-10')).toBe('2026-05-11')
    expect(nextBusinessDay('2026-05-01')).toBe('2026-05-04')
    expect(nextBusinessDay('2023-12-31')).toBe('2024-01-02')
    expect(() => nextBusinessDay('2026-02-30')).toThrow(/Invalid calendar date/)
    expect(() => DeclarationWorkflow.create(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId), 'not-a-timestamp')).toThrow(/event timestamp/)
    expect(() => DeclarationWorkflow.create(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId), '2026-02-30T00:00:00.000Z')).toThrow(/event timestamp/)
  })

  it('does not allow callers to forge official validation or submission outcomes', async () => {
    const mutable = { kind: 'USTVA' as const, period: '2026-01', taxpayerId: profile.companyId, formVersion: 'x', fields: { ZAHLLAST: 1 }, drilldown: { ZAHLLAST: ['entry'] } }
    const draft = DeclarationWorkflow.create(mutable); mutable.fields.ZAHLLAST = 999; mutable.drilldown.ZAHLLAST[0] = 'spoof'
    expect(draft.dataset.fields.ZAHLLAST).toBe(1); expect(draft.dataset.drilldown.ZAHLLAST).toEqual(['entry']); expect(Object.isFrozen(draft.dataset.fields)).toBe(true)
    expect(() => draft.validated({ valid: true, errors: [] }, Symbol('fake'), 'fake-gateway', 'fake-store')).toThrow(/configured gateway/)
    const forgedSubmitting = Object.create(DeclarationWorkflow.prototype) as DeclarationWorkflow
    expect(() => forgedSubmitting.submitted('accepted', '<fake/>', [], Symbol('fake'))).toThrow(/exact internally constructed/)
    const forgedValidated = Object.assign(Object.create(DeclarationWorkflow.prototype) as object, { state: 'validated', dataset: draft.dataset, events: draft.events, submissionId: draft.submissionId, gatewayId: 'vitest-in-memory-gateway' }) as DeclarationWorkflow
    const launderedApproved = Object.assign(Object.create(DeclarationWorkflow.prototype) as object, { state: 'approved', dataset: draft.dataset, events: draft.events, submissionId: draft.submissionId, gatewayId: 'vitest-in-memory-gateway' }) as DeclarationWorkflow
    const launderedAccepted = Object.assign(Object.create(DeclarationWorkflow.prototype) as object, { state: 'accepted', dataset: draft.dataset, events: draft.events, submissionId: draft.submissionId, gatewayId: 'vitest-in-memory-gateway', receipt: '<fake/>' }) as DeclarationWorkflow
    expect(() => forgedValidated.approved('actor')).toThrow(/exact internally constructed/)
    expect(() => launderedApproved.beginSubmission()).toThrow(/exact internally constructed/)
    expect(() => launderedAccepted.correction(draft.dataset)).toThrow(/exact internally constructed/)
    const fake = { validate: async () => ({ valid: true, errors: [] }) } as never
    await expect(validateWithGateway(draft, fake)).rejects.toThrow(/trusted gateway/)
    const exact = gateway(); const copied = { ...exact } as OfficialTaxGateway
    await expect(validateWithGateway(draft, copied)).rejects.toThrow(/exact configured/)
    const canonicalStore = createTestDeclarationWorkflowStore()
    const canonicalGateway = createConfiguredOfficialTaxGateway({ ...gateway() }, 'canonical-gateway-id', canonicalStore)
    expect(() => createConfiguredOfficialTaxGateway({ ...gateway() }, 'canonical-gateway-id', canonicalStore)).toThrow(/exactly one adapter instance/)
    const localeIndependentValidated = await validateWithGateway(DeclarationWorkflow.create({ ...mutable, fields: { 'ä': 1, z: 2 } }), canonicalGateway)
    const localeIndependent = await submitWithGateway(localeIndependentValidated.approved('actor'), canonicalGateway)
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare').mockImplementation(() => { throw new Error('locale-dependent ordering invoked') })
    try {
      await expect(persistDeclarationWorkflow(localeIndependent, canonicalStore)).resolves.toBeUndefined()
      await expect(restoreDeclarationWorkflow(localeIndependent.submissionId, canonicalStore)).resolves.toMatchObject({ submissionId: localeIndependent.submissionId })
    } finally { localeCompare.mockRestore() }
    const official = gateway(); const approved = (await validateWithGateway(DeclarationWorkflow.create(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId)), official)).approved('actor')
    const forgedApproved = Object.assign(Object.create(Object.getPrototypeOf(approved)) as object, approved) as DeclarationWorkflow
    await expect(submitWithGateway(forgedApproved, official)).rejects.toThrow(/exact internally constructed/)
    const accepted = await submitWithGateway(approved, official)
    const forgedAccepted = Object.assign(Object.create(Object.getPrototypeOf(accepted)) as object, accepted) as DeclarationWorkflow
    await expect(cancelWithGateway(forgedAccepted, 'actor', official)).rejects.toThrow(/exact internally constructed/)
    const uncertainGateway = gateway('uncertain'); const uncertain = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId)), uncertainGateway)).approved('actor'), uncertainGateway)
    const forgedUncertain = Object.assign(Object.create(Object.getPrototypeOf(uncertain)) as object, uncertain) as DeclarationWorkflow
    await expect(recoverWithGateway(forgedUncertain, uncertainGateway)).rejects.toThrow(/exact internally constructed/)
  })

  it('blocks missing form fields at schema validation', () => {
    const mapping = { kind: 'USTVA' as const, version: 'x', validFrom: '2026', validTo: '2026', requiredFields: ['ZAHLLAST'], fieldNames: { ZAHLLAST: 'Payable' } }
    const registry = new FormRegistry([mapping])
    expect(() => new FormRegistry([{ ...mapping, version: 'v1', validFrom: '2026', validTo: '2027' }, { ...mapping, version: 'v2', validFrom: '2027', validTo: '2028' }])).toThrow(/overlapping validity ranges/)
    mapping.requiredFields[0] = 'FORGED'; mapping.fieldNames.ZAHLLAST = 'Forged'
    expect(registry.resolve('USTVA', '2026-01')).toMatchObject({ requiredFields: ['ZAHLLAST'], fieldNames: { ZAHLLAST: 'Payable' } })
    expect(Object.isFrozen(registry.mappings[0].requiredFields)).toBe(true)
    expect(() => registry.prepare('USTVA', '2026-01', {})).toThrow(TaxDeclarationError)
    expect(() => registry.prepare('USTVA', '2026-01', Object.create({ ZAHLLAST: 1 }) as Record<string, number>)).toThrow(TaxDeclarationError)
    expect(() => registry.prepare('USTVA', '2026-01', { ZAHLLAST: 1, OPTIONAL: undefined } as never, {}, profile.companyId)).toThrow(/must not contain undefined/)
  })

  it('uses explicit gateway correction and cancellation protocols', async () => {
    const correctSpy = vi.fn(async () => ({ outcome: 'accepted' as const, receipt: '<correction/>' })); const cancelSpy = vi.fn(async () => ({ outcome: 'accepted' as const, receipt: '<cancel/>' })); const official = createTestOfficialTaxGateway({ ...gateway(), correct: correctSpy, cancel: cancelSpy }); const dataset = taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId)
    const accepted = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), official)).approved('actor'), official)
    const correction = accepted.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 2 }, {}, profile.companyId)).correction
    const conflictingCorrection = accepted.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 3 }, {}, profile.companyId)).correction
    await submitWithGateway((await validateWithGateway(correction, official)).approved('actor'), official)
    expect(correctSpy).toHaveBeenCalledWith(accepted.submissionId, expect.anything(), expect.any(String))
    await expect(submitWithGateway((await validateWithGateway(conflictingCorrection, official)).approved('actor'), official)).rejects.toThrow(/conflicting official action/)
    const other = createConfiguredOfficialTaxGateway({ ...gateway() }, 'other-production-adapter', createTestDeclarationWorkflowStore())
    await expect(validateWithGateway(accepted.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 4 }, {}, profile.companyId)).correction, other)).rejects.toThrow(/original declaration/)
    await expect(cancelWithGateway(accepted, 'actor', official)).rejects.toThrow(/conflicting official action/)
    const cancellable = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), official)).approved('actor'), official)
    await cancelWithGateway(cancellable, 'actor', official)
    expect(cancelSpy).toHaveBeenCalledWith(cancellable.submissionId, `cancel:${cancellable.submissionId}`)
    await expect(submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), official)).approved('actor'), other)).rejects.toThrow(/identit.*must match/)
    const rejectingCorrectionGateway = createTestOfficialTaxGateway({ ...gateway(), correct: vi.fn(async () => ({ outcome: 'rejected' as const, errors: ['correction rejected'] })) })
    const rejectableOriginal = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), rejectingCorrectionGateway)).approved('actor'), rejectingCorrectionGateway)
    const rejectedCorrection = rejectableOriginal.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 9 }, {}, profile.companyId)).correction
    await expect(submitWithGateway((await validateWithGateway(rejectedCorrection, rejectingCorrectionGateway)).approved('actor'), rejectingCorrectionGateway)).resolves.toMatchObject({ state: 'rejected' })
    await expect(cancelWithGateway(rejectableOriginal, 'actor', rejectingCorrectionGateway)).resolves.toMatchObject({ state: 'cancelled' })
  })

  it('preserves uncertain/rejected cancellation history and recovers with its idempotency key', async () => {
    const dataset = taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId)
    const uncertainGateway = createTestOfficialTaxGateway({ ...gateway(), cancel: vi.fn(async () => ({ outcome: 'uncertain' as const })), recover: vi.fn().mockResolvedValueOnce({ outcome: 'uncertain' as const }).mockResolvedValue({ outcome: 'accepted' as const, receipt: '<cancel-recovered/>' }) })
    const accepted = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), uncertainGateway)).approved('actor'), uncertainGateway)
    const uncertain = await cancelWithGateway(accepted, 'actor', uncertainGateway)
    expect(uncertain).toMatchObject({ state: 'uncertain', idempotencyKey: `cancel:${accepted.submissionId}` })
    expect((await recoverWithGateway(uncertain, uncertainGateway))).toMatchObject({ state: 'uncertain' })
    const restoredCancellation = await restoreDeclarationWorkflow(uncertain.submissionId, uncertainGateway.workflowStore)
    expect((await recoverWithGateway(restoredCancellation, uncertainGateway))).toMatchObject({ state: 'cancelled', receipt: '<cancel-recovered/>' })
    const rejectingGateway = createTestOfficialTaxGateway({ ...gateway(), cancel: vi.fn(async () => ({ outcome: 'rejected' as const, errors: ['cancellation rejected'] })) })
    const acceptedAgain = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), rejectingGateway)).approved('actor'), rejectingGateway)
    const rejected = await cancelWithGateway(acceptedAgain, 'actor', rejectingGateway)
    expect(rejected.state).toBe('accepted'); expect(rejected.events.at(-1)?.payload.errors).toEqual(['cancellation rejected'])
    const rejectedCorrection = rejected.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 2 }, {}, profile.companyId)).correction
    const acceptedRejectedCorrection = await submitWithGateway((await validateWithGateway(rejectedCorrection, rejectingGateway)).approved('actor'), rejectingGateway)
    expect((await finalizeAcceptedCorrection(rejected, acceptedRejectedCorrection, rejectingGateway.workflowStore)).state).toBe('corrected')
    const recoveryRejectGateway = createTestOfficialTaxGateway({ ...gateway(), cancel: vi.fn(async () => ({ outcome: 'uncertain' as const })), recover: vi.fn(async () => ({ outcome: 'rejected' as const, errors: ['cancellation still rejected'] })) })
    const acceptedThird = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), recoveryRejectGateway)).approved('actor'), recoveryRejectGateway)
    const recoveredRejected = await recoverWithGateway(await cancelWithGateway(acceptedThird, 'actor', recoveryRejectGateway), recoveryRejectGateway)
    const recoveredCorrection = recoveredRejected.correction(taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 3 }, {}, profile.companyId)).correction
    const acceptedRecoveredCorrection = await submitWithGateway((await validateWithGateway(recoveredCorrection, recoveryRejectGateway)).approved('actor'), recoveryRejectGateway)
    expect((await finalizeAcceptedCorrection(recoveredRejected, acceptedRecoveredCorrection, recoveryRejectGateway.workflowStore)).state).toBe('corrected')
  })

  it('rejects filing keys whose supplied date boundaries are not canonical', () => {
    const detail = calculateVat({ ownerId: 'company-1', sourceId: 'sale', amountCents: 100, mode: 'net', taxPoint: '2026-01-02', ruleId: 'DE_STANDARD' }, createTestVatRuleBook(representativeGermanVatRules))
    const reconciliation = reconcileVat([detail], { outputTaxCents: 19, inputTaxCents: 0 })
    expect(() => deriveVatDatasets({ key: '2026-01', from: '2026-01-02', to: '2026-01-31', dueDate: '2026-02-10' }, profile, [detail], reconciliation, taxFormRegistry)).toThrow(/canonical boundaries/)
    expect(() => deriveVatDatasets(deriveVatPeriods(2026, profile)[0], { ...profile, companyId: 'other-company' }, [detail], reconciliation, taxFormRegistry)).toThrow(/match the filing profile taxpayer/)
  })

  it('preserves recovered rejection diagnostics', async () => {
    const official = createTestOfficialTaxGateway({ ...gateway('uncertain'), recover: vi.fn(async () => ({ outcome: 'rejected' as const, errors: ['recovery rejected'] })) })
    const dataset = taxFormRegistry.prepare('USTVA', '2026-01', { ZAHLLAST: 1 }, {}, profile.companyId)
    const uncertain = await submitWithGateway((await validateWithGateway(DeclarationWorkflow.create(dataset), official)).approved('actor'), official)
    const rejected = await recoverWithGateway(uncertain, official)
    expect(rejected.events.at(-1)?.payload.errors).toEqual(['recovery rejected'])
    await expect(restoreDeclarationWorkflow(rejected.submissionId, official.workflowStore)).resolves.toMatchObject({ state: 'rejected', events: expect.arrayContaining([expect.objectContaining({ type: 'submission-rejected', payload: expect.objectContaining({ errors: ['recovery rejected'] }) })]) })
  })

  it('supports only EU VAT prefixes used by ZM including Greek EL', () => {
    const elEvidence = createTestVatIdValidationEvidence('EL123456789', 'GR')
    expect(() => validateZmEntries([{ customerVatId: 'EL123456789', validationEvidence: elEvidence, supplyKind: 'goods', amountCents: 1, sourceIds: ['e'] }])).not.toThrow()
    expect(() => validateZmEntries([{ customerVatId: 'US123456789', validationEvidence: elEvidence, supplyKind: 'goods', amountCents: 1, sourceIds: ['e'] }])).toThrow(/invalid non-German EU/)
  })
})
