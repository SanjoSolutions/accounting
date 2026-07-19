import { describe, expect, it } from 'vitest'
import { canonicalJson } from './auditExport'
import { createAssetSchedules, type FixedAsset } from './assetsInventory'
import { createEBalanceAssetAttachments, createEBalancePayloadEvidence, createEBalanceReport, createEBalanceSemanticFacts, type EBalanceProfile, type TaxonomyRelease } from './eBilanzLifecycle'

const tenantId = 'tenant-cycle-37'
const profile: EBalanceProfile = { tenantId, companyName: 'Example GmbH', legalForm: 'GMBH', taxNumber: '1234567890', fiscalPeriodStart: '2026-01-01', fiscalPeriodEnd: '2026-12-31', accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }
const taxonomy: TaxonomyRelease = { version: '6.10', validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31', gaapNamespace: 'gaap-6.10', gcdNamespace: 'gcd-6.10', entryPoint: '6.10.xsd', archiveSha256: 'a'.repeat(64) }
let representedPayload: unknown = {}
const serializer = { serialize: (payload: Readonly<Record<string, unknown>>) => { representedPayload = payload; return `<xbrl xmlns="http://www.xbrl.org/2003/instance">${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` }, parseRoot: () => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance', representedPayload }) }
const facts = [{ concept: 'is.netIncome', context: 'duration' as const, amountCents: 0, unit: 'EUR' as const, accountIds: [] }]

describe('cycle 37 typed E-Bilanz asset attachments', () => {
  it('accepts explicit empty arrays for a valid no-asset company', () => {
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], createEBalanceAssetAttachments(profile), serializer)).not.toThrow()
  })

  it('rejects truthy placeholders, non-arrays and malformed rows before serialization', () => {
    for (const attachments of [true, {}, { assetSchedule: true, assetRegister: [] }, { assetSchedule: {}, assetRegister: [] }, { assetSchedule: 'rows', assetRegister: [] }, { assetSchedule: { ...createEBalanceAssetAttachments(profile).assetSchedule, rows: [{}] }, assetRegister: createEBalanceAssetAttachments(profile).assetRegister }, { assetSchedule: createEBalanceAssetAttachments(profile).assetSchedule, assetRegister: { ...createEBalanceAssetAttachments(profile).assetRegister, rows: [{}] } }]) expect(() => createEBalanceReport(profile, taxonomy, facts, [], attachments as never, serializer)).toThrow(/structured object|canonical tenant|malformed canonical row/)
  })

  it('accepts canonical schedule/register output and rejects mismatched asset identities', () => {
    const asset: FixedAsset = { id: 'asset-1', tenantId, description: 'Machine', costCents: 1200, acquisitionDate: '2026-01-01', availableForUseDate: '2026-01-01', location: 'Berlin', usefulLifeMonths: 12, method: 'NO_DEPRECIATION', taxUsefulLifeMonths: 12, taxMethod: 'NO_DEPRECIATION', evidenceIds: ['invoice'] }
    const schedules = createAssetSchedules(tenantId, [asset], [], { start: '2026-01-01', end: '2026-12-31' })
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], schedules.eBalanceAttachments, serializer)).not.toThrow()
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], createEBalanceAssetAttachments(profile, schedules.hgbAnlagenspiegel, []), serializer)).toThrow('same unique assets')
  })
})
