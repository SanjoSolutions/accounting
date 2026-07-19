import { describe, expect, it } from 'vitest'
import { canonicalJson } from './auditExport'
import { createAssetSchedules, type FixedAsset } from './assetsInventory'
import { createEBalanceAssetAttachments, createEBalancePayloadEvidence, createEBalanceReport, createEBalanceSemanticFacts, type EBalanceAttachments, type EBalanceProfile, type EBalanceSupportingBalance, type TaxAdjustment, type TaxonomyRelease } from './eBilanzLifecycle'

const profile: EBalanceProfile = { tenantId: 'tenant-cycle-38', companyName: 'Example GmbH', legalForm: 'GMBH', taxNumber: '1234567890', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }
const taxonomy: TaxonomyRelease = { version: '6.10', validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31', gaapNamespace: 'gaap-6.10', gcdNamespace: 'gcd-6.10', entryPoint: '6.10.xsd', archiveSha256: 'a'.repeat(64) }
let representedPayload: unknown = {}
const serializer = { serialize: (payload: Readonly<Record<string, unknown>>) => { representedPayload = payload; return `<xbrl xmlns="http://www.xbrl.org/2003/instance">${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` }, parseRoot: () => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance', representedPayload }) }
const facts = [{ concept: 'is.netIncome', context: 'duration' as const, amountCents: 0, unit: 'EUR' as const, accountIds: [] }]
const asset = (tenantId = profile.tenantId): FixedAsset => ({ id: 'asset-1', tenantId, description: 'Machine', costCents: 1200, acquisitionDate: '2026-01-01', availableForUseDate: '2026-01-01', location: 'Berlin', usefulLifeMonths: 12, method: 'NO_DEPRECIATION', taxUsefulLifeMonths: 12, taxMethod: 'NO_DEPRECIATION', evidenceIds: ['invoice'] })

describe('cycle 38 E-Bilanz asset envelope and reconciliation integrity', () => {
  it('preserves schedule tenant/period identity and rejects cross-tenant or cross-period reuse', () => {
    const schedules = createAssetSchedules(profile.tenantId, [asset()], [], { start: profile.fiscalPeriodStart, end: profile.fiscalPeriodEnd })
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], schedules.eBalanceAttachments, serializer)).not.toThrow()
    for (const patch of [{ tenantId: 'other-tenant' }, { fiscalPeriodStart: '2025-01-01' }, { fiscalPeriodEnd: '2025-12-31' }]) {
      expect(() => createEBalanceReport(profile, taxonomy, facts, [], { assetSchedule: { ...schedules.eBalanceAttachments.assetSchedule, ...patch }, assetRegister: schedules.eBalanceAttachments.assetRegister }, serializer)).toThrow('canonical tenant and fiscal-period envelopes')
      expect(() => createEBalanceReport(profile, taxonomy, facts, [], { assetSchedule: schedules.eBalanceAttachments.assetSchedule, assetRegister: { ...schedules.eBalanceAttachments.assetRegister, ...patch } }, serializer)).toThrow('canonical tenant and fiscal-period envelopes')
    }
    const foreign = createAssetSchedules('other-tenant', [asset('other-tenant')], [], { start: profile.fiscalPeriodStart, end: profile.fiscalPeriodEnd })
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], foreign.eBalanceAttachments, serializer)).toThrow('canonical tenant and fiscal-period envelopes')
    expect(() => createAssetSchedules(profile.tenantId, [asset(), { ...asset('other-tenant'), id: 'asset-2' }], [], { start: profile.fiscalPeriodStart, end: profile.fiscalPeriodEnd })).toThrow('must match the authoritative schedule tenant identity')
  })

  it('keeps explicit no-asset rows valid only inside matching canonical envelopes', () => {
    const schedules = createAssetSchedules(profile.tenantId, [], [], { start: profile.fiscalPeriodStart, end: profile.fiscalPeriodEnd })
    expect(schedules).toMatchObject({ tenantId: profile.tenantId, period: { start: profile.fiscalPeriodStart, end: profile.fiscalPeriodEnd }, hgbAnlagenspiegel: [], eBilanzAnlagenverzeichnis: [] })
    expect(schedules.eBalanceAttachments).toEqual(createEBalanceAssetAttachments(profile))
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], schedules.eBalanceAttachments, serializer)).not.toThrow()
    expect(() => createAssetSchedules(' ', [], [], { start: profile.fiscalPeriodStart, end: profile.fiscalPeriodEnd })).toThrow('nonblank authoritative tenant identity')
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], { assetSchedule: { rows: [] }, assetRegister: { rows: [] } } as never, serializer)).toThrow('canonical tenant and fiscal-period envelopes')
  })

  it('rejects every broken asset-schedule movement equation and register reconciliation', () => {
    const attachments = createAssetSchedules(profile.tenantId, [asset()], [], { start: profile.fiscalPeriodStart, end: profile.fiscalPeriodEnd }).eBalanceAttachments
    const schedule = attachments.assetSchedule.rows[0]
    for (const patch of [{ closingCostCents: schedule.closingCostCents + 1 }, { costCents: schedule.costCents + 1 }, { closingAccumulatedDepreciationCents: 1 }, { accumulatedDepreciationCents: 1 }, { carryingAmountCents: schedule.carryingAmountCents + 1 }]) {
      const malformed = { ...attachments, assetSchedule: { ...attachments.assetSchedule, rows: [{ ...schedule, ...patch }] } }
      expect(() => createEBalanceReport(profile, taxonomy, facts, [], malformed, serializer)).toThrow('movement arithmetic does not reconcile')
    }
    const register = attachments.assetRegister.rows[0]
    const malformedRegister = { ...attachments, assetRegister: { ...attachments.assetRegister, rows: [{ ...register, bookTaxDifferenceCents: register.bookTaxDifferenceCents + 1 }] } }
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], malformedRegister, serializer)).toThrow('book/tax difference does not reconcile')
    const futureRegister = { ...attachments, assetRegister: { ...attachments.assetRegister, rows: [{ ...register, acquisitionDate: '2027-01-01' }] } }
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], futureRegister, serializer)).toThrow('acquisition date cannot be after the report fiscal-period end')
  })

  it('exports and enforces a canonical closing asset snapshot after disposal', () => {
    const disposal = { id: 'disposal', assetId: 'asset-1', sequence: 1, type: 'DISPOSAL' as const, effectiveDate: '2026-06-01', amountCents: 0, approvedBy: 'Controller', approvedAt: '2026-06-01T12:00:00Z', postingId: 'journal-disposal', evidenceIds: ['sale'] }
    const schedules = createAssetSchedules(profile.tenantId, [asset()], [disposal], { start: profile.fiscalPeriodStart, end: profile.fiscalPeriodEnd })
    expect(schedules.hgbAnlagenspiegel[0]).toMatchObject({ costCents: 1200, disposalsCents: 1200, closingCostCents: 0 })
    const schedule = schedules.eBalanceAttachments.assetSchedule.rows[0]
    expect(schedule).toMatchObject({ costCents: 0, disposalsCents: 1200, closingCostCents: 0, accumulatedDepreciationCents: 0, carryingAmountCents: 0 })
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], schedules.eBalanceAttachments, serializer)).not.toThrow()
    const grossSnapshot = { ...schedules.eBalanceAttachments, assetSchedule: { ...schedules.eBalanceAttachments.assetSchedule, rows: [{ ...schedule, costCents: 1200 }] } }
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], grossSnapshot, serializer)).toThrow('movement arithmetic does not reconcile')
  })

  it('rejects sparse fact-account and asset-transfer identifier arrays while allowing genuine empties', () => {
    const sparseAccountIds: string[] = []; sparseAccountIds.length = 1
    expect(() => createEBalanceReport(profile, taxonomy, [{ ...facts[0], accountIds: sparseAccountIds }], [], createEBalanceAssetAttachments(profile), serializer)).toThrow('dense own elements')
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], createEBalanceAssetAttachments(profile), serializer)).not.toThrow()
    const attachments = createAssetSchedules(profile.tenantId, [asset()], [], { start: profile.fiscalPeriodStart, end: profile.fiscalPeriodEnd }).eBalanceAttachments
    const sparseTransferIds: string[] = []; sparseTransferIds.length = 1
    const schedule = { ...attachments.assetSchedule.rows[0], transferEventIds: sparseTransferIds }
    const malformed = { ...attachments, assetSchedule: { ...attachments.assetSchedule, rows: [schedule] } }
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], malformed, serializer)).toThrow('malformed canonical row')
  })

  it('requires facts and adjustments to use own enumerable data fields and exports only canonical fields', () => {
    expect(() => createEBalanceReport(profile, taxonomy, [Object.create(facts[0])], [], createEBalanceAssetAttachments(profile), serializer)).toThrow('serialization ownership')
    const factWithHiddenAmount = { ...facts[0] }; Object.defineProperty(factWithHiddenAmount, 'amountCents', { value: 0, enumerable: false })
    expect(() => createEBalanceReport(profile, taxonomy, [factWithHiddenAmount], [], createEBalanceAssetAttachments(profile), serializer)).toThrow('serialization ownership')
    let factReads = 0; const accessorFact = { ...facts[0] } as Record<string, unknown>; Object.defineProperty(accessorFact, 'concept', { enumerable: true, get: () => { factReads += 1; return 'is.netIncome' } })
    expect(() => createEBalanceReport(profile, taxonomy, [accessorFact as never], [], createEBalanceAssetAttachments(profile), serializer)).toThrow('serialization ownership'); expect(factReads).toBe(0)

    const adjustment: TaxAdjustment = { id: 'adjustment-1', accountId: '8400', description: 'Permanent adjustment', type: 'PERMANENT', amountCents: 1, evidenceIds: ['evidence'] }
    expect(() => createEBalanceReport(profile, taxonomy, facts, [Object.create(adjustment)], createEBalanceAssetAttachments(profile), serializer)).toThrow('own enumerable canonical fields')
    let adjustmentReads = 0; const accessorAdjustment = { ...adjustment } as Record<string, unknown>; Object.defineProperty(accessorAdjustment, 'description', { enumerable: true, get: () => { adjustmentReads += 1; return 'Permanent adjustment' } })
    expect(() => createEBalanceReport(profile, taxonomy, facts, [accessorAdjustment as never], createEBalanceAssetAttachments(profile), serializer)).toThrow('own enumerable canonical fields'); expect(adjustmentReads).toBe(0)
    const report = createEBalanceReport(profile, taxonomy, [{ ...facts[0], ignoredFactField: 'discard' } as never], [{ ...adjustment, ignoredAdjustmentField: 'discard' } as never], createEBalanceAssetAttachments(profile), serializer)
    expect(report.payload.facts[0]).not.toHaveProperty('ignoredFactField'); expect(report.payload.taxReconciliation.adjustments[0]).not.toHaveProperty('ignoredAdjustmentField')
  })

  it('captures top-level report inputs as own-data snapshots without invoking accessors', () => {
    let reads = 0; const accessorProfile = { ...profile } as Record<string, unknown>; Object.defineProperty(accessorProfile, 'tenantId', { enumerable: true, get: () => { reads += 1; return reads === 1 ? profile.tenantId : 'other-tenant' } })
    expect(() => createEBalanceReport(accessorProfile as never, taxonomy, facts, [], createEBalanceAssetAttachments(profile), serializer)).toThrow('own enumerable data'); expect(reads).toBe(0)
    const accessorTaxonomy = { ...taxonomy } as Record<string, unknown>; Object.defineProperty(accessorTaxonomy, 'version', { enumerable: true, get: () => { reads += 1; return taxonomy.version } })
    expect(() => createEBalanceReport(profile, accessorTaxonomy as never, facts, [], createEBalanceAssetAttachments(profile), serializer)).toThrow('own enumerable data'); expect(reads).toBe(0)
    const accessorAttachments = { ...createEBalanceAssetAttachments(profile) } as Record<string, unknown>; Object.defineProperty(accessorAttachments, 'assetSchedule', { enumerable: true, get: () => { reads += 1; return createEBalanceAssetAttachments(profile).assetSchedule } })
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], accessorAttachments as never, serializer)).toThrow('own enumerable data'); expect(reads).toBe(0)
  })

  it('rejects non-canonical asset and supporting-balance rows and strips undeclared row fields', () => {
    const attachments = createAssetSchedules(profile.tenantId, [asset()], [], { start: profile.fiscalPeriodStart, end: profile.fiscalPeriodEnd }).eBalanceAttachments
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], { ...attachments, assetSchedule: { ...attachments.assetSchedule, rows: [Object.create(attachments.assetSchedule.rows[0])] } }, serializer)).toThrow('malformed canonical row')
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], { ...attachments, assetRegister: { ...attachments.assetRegister, rows: [Object.create(attachments.assetRegister.rows[0])] } }, serializer)).toThrow('malformed canonical row')
    const decoratedAssets: EBalanceAttachments = { assetSchedule: { ...attachments.assetSchedule, rows: [{ ...attachments.assetSchedule.rows[0], ignoredScheduleField: 'discard' } as never] }, assetRegister: { ...attachments.assetRegister, rows: [{ ...attachments.assetRegister.rows[0], ignoredRegisterField: 'discard' } as never] } }
    const assetReport = createEBalanceReport(profile, taxonomy, facts, [], decoratedAssets, serializer)
    expect(assetReport.payload.attachments.assetSchedule.rows[0]).not.toHaveProperty('ignoredScheduleField'); expect(assetReport.payload.attachments.assetRegister.rows[0]).not.toHaveProperty('ignoredRegisterField')

    const supporting: EBalanceSupportingBalance = { id: 'special-1', kind: 'SPECIAL_BALANCE', tenantId: profile.tenantId, fiscalPeriodStart: profile.fiscalPeriodStart, fiscalPeriodEnd: profile.fiscalPeriodEnd, facts: [{ concept: 'special.equity', context: 'instant', amountCents: 1, unit: 'EUR', accountIds: ['2900'] }], reconciliation: [{ id: 'row-1', accountId: '2900', description: 'Reconciliation', commercialAmountCents: 0, taxAmountCents: 1, differenceCents: 1, evidenceIds: ['evidence'] }] }
    const requiredProfile = { ...profile, specialBalanceRequired: true }
    expect(() => createEBalanceReport(requiredProfile, taxonomy, facts, [], { ...attachments, specialBalance: { ...supporting, reconciliation: [Object.create(supporting.reconciliation[0])] } }, serializer)).toThrow('invalid reconciliation data')
    const supportingReport = createEBalanceReport(requiredProfile, taxonomy, facts, [], { ...attachments, specialBalance: { ...supporting, reconciliation: [{ ...supporting.reconciliation[0], ignoredReconciliationField: 'discard' } as never] } }, serializer)
    expect(supportingReport.payload.attachments.specialBalance?.reconciliation[0]).not.toHaveProperty('ignoredReconciliationField')
  })
})
