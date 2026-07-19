import { describe, expect, it, vi } from 'vitest'
import { applyAssetEvents, closePhysicalInventory, createAssetSchedules, type FixedAsset, type InventoryCount, type InventoryItem, type InventoryPeriod } from './assetsInventory'
import { createEBalanceAssetAttachments, createEBalancePayloadEvidence, createEBalanceReport, createEBalanceSemanticFacts, planTaxonomyUpgrade, validateWithEric, type EBalanceProfile, type EBalanceXmlSerializer, type TaxonomyRelease } from './eBilanzLifecycle'

const tenantId = 'tenant-cycle-63'
const period: InventoryPeriod = { start: '2026-01-01', end: '2026-12-31', timeZone: 'Europe/Berlin' }
const asset: FixedAsset = { id: 'asset-1', tenantId, description: 'Machine', costCents: 1200, acquisitionDate: '2026-01-01', availableForUseDate: '2026-01-01', location: 'Plant', usefulLifeMonths: 12, method: 'STRAIGHT_LINE', taxUsefulLifeMonths: 12, taxMethod: 'STRAIGHT_LINE', evidenceIds: ['invoice'] }
const item: InventoryItem = { id: 'item-1', tenantId, sku: 'SKU-1', description: 'Part', location: 'Warehouse', quantity: 1, unitCostCents: 100 }
const count: InventoryCount = { itemId: item.id, countedQuantity: 1, countedBy: 'counter', countedAt: '2026-12-31T10:00:00Z', evidenceIds: ['photo'], approvedBy: 'approver', approvedAt: '2026-12-31T11:00:00Z' }

const profile: EBalanceProfile = { tenantId, companyName: 'Example GmbH', legalForm: 'GmbH', taxNumber: '12/345/67890', fiscalPeriodStart: period.start, fiscalPeriodEnd: period.end, accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }
const taxonomy: TaxonomyRelease = { version: '6.9', validForFiscalPeriodsStartingFrom: '2026-01-01', validForFiscalPeriodsStartingThrough: '2026-12-31', gaapNamespace: 'urn:gaap', gcdNamespace: 'urn:gcd', entryPoint: 'https://example.invalid/taxonomy.xsd', archiveSha256: 'a'.repeat(64) }
const facts = [{ concept: 'is.netIncome', context: 'duration' as const, amountCents: 0, unit: 'EUR' as const, accountIds: [] }]
const attachments = createEBalanceAssetAttachments(profile)
const xmlRoot = '<xbrl xmlns="http://www.xbrl.org/2003/instance">'

function serializer(parseRoot: (xml: string) => unknown): EBalanceXmlSerializer {
  return {
    serialize(payload) { return `${xmlRoot}${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` },
    parseRoot(xml) { return parseRoot(xml) as ReturnType<EBalanceXmlSerializer['parseRoot']> },
  }
}

describe('reporting cycle 63 input projection and structural validation', () => {
  it('projects the inventory period to one normalized start/end/timeZone snapshot for validation, sealing and return', () => {
    const supplied = { ...period, injected: 'must-not-leak' }
    const result = closePhysicalInventory(tenantId, supplied, [item], [count], '2026-12-31T12:00:00Z')

    expect(result.period).toEqual(period)
    expect(Object.keys(result.period)).toEqual(['start', 'end', 'timeZone'])
    expect(JSON.parse(result.immutablePayload).period).toEqual(period)
    expect(result.immutablePayload).not.toContain('injected')
    supplied.end = '2027-12-31'
    expect(result.period.end).toBe('2026-12-31')
  })

  it('deep-freezes the returned physical-inventory close graph after sealing it', () => {
    const result = closePhysicalInventory(tenantId, period, [item], [count], '2026-12-31T12:00:00Z')
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.period)).toBe(true)
    expect(Object.isFrozen(result.rows)).toBe(true)
    expect(Object.isFrozen(result.rows[0])).toBe(true)
    expect(Object.isFrozen(result.rows[0].evidenceIds)).toBe(true)
    expect(() => { result.rows[0].countedQuantity = 99 }).toThrow()
    expect(() => { result.rows[0].evidenceIds[0] = 'forged' }).toThrow()
    expect(result.immutablePayload).toContain('"countedQuantity":1')
  })

  it('projects the asset schedule period to one inert start/end snapshot', () => {
    const supplied = { start: period.start, end: period.end, injected: 'must-not-leak' }
    const result = createAssetSchedules(tenantId, [asset], [], supplied)
    supplied.end = '2027-12-31'
    expect(result.period).toEqual({ start: period.start, end: period.end })
    expect(Object.keys(result.period)).toEqual(['start', 'end'])
    expect(result.eBalanceAttachments.assetSchedule.fiscalPeriodEnd).toBe(period.end)
    let reads = 0
    const accessorPeriod = Object.create(Object.prototype)
    Object.defineProperties(accessorPeriod, { start: { enumerable: true, get() { reads += 1; return period.start } }, end: { enumerable: true, value: period.end } })
    expect(() => createAssetSchedules(tenantId, [asset], [], accessorPeriod)).toThrow('own enumerable data fields')
    expect(reads).toBe(0)
  })

  it('rejects non-array and sparse asset-event collections before event filtering', () => {
    expect(() => applyAssetEvents(asset, { filter: () => [] } as never, period.end)).toThrow('Asset events must be a dense array')
    expect(() => applyAssetEvents(asset, new Array(1) as never, period.end)).toThrow('Asset events must be a dense array')
    expect(() => applyAssetEvents(asset, [null] as never, period.end)).toThrow('Asset event must be a structured record')
    expect(() => createAssetSchedules(tenantId, [null] as never, [], period)).toThrow('Asset master must be a structured record')
    expect(() => createAssetSchedules(tenantId, [asset], [null] as never, period)).toThrow('Asset event must be a structured record')
  })

  it('rejects sparse inventory item and count collections before any traversal can skip holes', () => {
    expect(() => closePhysicalInventory(tenantId, period, new Array(1) as InventoryItem[], [], '2026-12-31T12:00:00Z')).toThrow('Inventory items must be a dense array')
    expect(() => closePhysicalInventory(tenantId, period, [], new Array(1) as InventoryCount[], '2026-12-31T12:00:00Z')).toThrow('Inventory counts must be a dense array')
    expect(() => closePhysicalInventory(tenantId, period, {} as never, [], '2026-12-31T12:00:00Z')).toThrow('Inventory items must be a dense array')
    expect(() => closePhysicalInventory(tenantId, period, [null] as never, [], '2026-12-31T12:00:00Z')).toThrow('Inventory item must be a structured record')
    expect(() => closePhysicalInventory(tenantId, period, [], [null] as never, '2026-12-31T12:00:00Z')).toThrow('Inventory count must be a structured record')
  })

  it('captures one parseRoot response and accepts only own fields with exact types and wellFormed true', () => {
    const parseRoot = vi.fn(() => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance' }))
    const report = createEBalanceReport(profile, taxonomy, facts, [], attachments, serializer(parseRoot))
    expect(report.content).toContain(createEBalancePayloadEvidence(report.payload))
    expect(parseRoot).toHaveBeenCalledTimes(1)

    expect(() => createEBalanceReport(profile, taxonomy, facts, [], attachments, serializer(() => ({ wellFormed: 1, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance' }) as never))).toThrow('exact boolean and string types')
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], attachments, serializer(() => ({ wellFormed: true, localName: new String('xbrl'), namespaceUri: 'http://www.xbrl.org/2003/instance' }) as never))).toThrow('exact boolean and string types')
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], attachments, serializer(() => ({ wellFormed: false, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance' })))).toThrow('parser-verified')
    const inherited = Object.create({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance' })
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], attachments, serializer(() => inherited))).toThrow('own enumerable data properties')
  })

  it('requires primitive strings for authoritative profile and supporting-balance identity fields', () => {
    const stringLike = { trim: () => 'forged' }
    expect(() => createEBalanceReport({ ...profile, companyName: stringLike as never }, taxonomy, facts, [], attachments, serializer(() => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance' })))).toThrow('company profile is incomplete')

    const validBalance = {
      id: 'balance-1', kind: 'SPECIAL_BALANCE' as const, tenantId, fiscalPeriodStart: period.start, fiscalPeriodEnd: period.end,
      facts,
      reconciliation: [{ id: 'reconciliation-1', accountId: '1000', description: 'Tax adjustment', commercialAmountCents: 0, taxAmountCents: 0, differenceCents: 0, evidenceIds: ['evidence'] }],
    }
    const requiredProfile = { ...profile, specialBalanceRequired: true }
    for (const malformed of [
      { ...validBalance, id: stringLike as never },
      { ...validBalance, reconciliation: [{ ...validBalance.reconciliation[0], id: stringLike as never }] },
      { ...validBalance, reconciliation: [{ ...validBalance.reconciliation[0], accountId: stringLike as never }] },
      { ...validBalance, reconciliation: [{ ...validBalance.reconciliation[0], description: stringLike as never }] },
    ]) {
      expect(() => createEBalanceReport(requiredProfile, taxonomy, facts, [], { ...attachments, specialBalance: malformed }, serializer(() => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance' })))).toThrow(/invalid identity|invalid reconciliation/)
    }
  })

  it('preserves stateful serializer and ERiC validator receivers after validating their own methods', async () => {
    const statefulSerializer = {
      root: xmlRoot,
      namespaceUri: 'http://www.xbrl.org/2003/instance',
      representedPayload: {} as unknown,
      serialize(payload: Readonly<Record<string, unknown>>) { this.representedPayload = payload; return `${this.root}${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` },
      parseRoot() { return { wellFormed: true, localName: 'xbrl', namespaceUri: this.namespaceUri, representedPayload: this.representedPayload } },
    }
    const report = createEBalanceReport(profile, taxonomy, facts, [], attachments, statefulSerializer)
    const statefulValidator = {
      engineVersion: 'ERIC-63',
      async validate(content: string) { return { valid: content === report.content, diagnostics: [], engineVersion: this.engineVersion } },
    }
    await expect(validateWithEric(report, statefulValidator, '2026-12-31T13:00:00Z')).resolves.toMatchObject({ valid: true, engineVersion: 'ERIC-63' })
  })

  it('uses descriptor-captured attachment and nested identifier arrays for both validation and payload normalization', () => {
    const malformedRows = [{}] as never[]
    Object.defineProperty(malformedRows, Symbol.iterator, { value: function* () {}, configurable: true })
    const hostileAttachments = {
      assetSchedule: { tenantId, fiscalPeriodStart: period.start, fiscalPeriodEnd: period.end, rows: malformedRows },
      assetRegister: { tenantId, fiscalPeriodStart: period.start, fiscalPeriodEnd: period.end, rows: [] },
    }
    expect(() => createEBalanceReport(profile, taxonomy, facts, [], hostileAttachments as never, serializer(() => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance' })))).toThrow('malformed canonical row')

    const accountIds = ['1000']
    Object.defineProperty(accountIds, Symbol.iterator, { value: function* () { yield 'forged-account' }, configurable: true })
    const report = createEBalanceReport(profile, taxonomy, [{ ...facts[0], accountIds }], [], attachments, serializer(() => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance' })))
    expect(report.payload.facts[0].accountIds).toEqual(['1000'])
  })

  it('isolates and freezes canonical payload snapshots before invoking an external serializer', () => {
    let retained: Readonly<Record<string, unknown>> | undefined
    const mutatingSerializer: EBalanceXmlSerializer = {
      serialize(payload) { retained = payload; try { (payload as Record<string, unknown>).gcd = { tenantId: 'forged' } } catch { /* frozen as required */ } return `${xmlRoot}${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` },
      parseRoot: () => ({ wellFormed: true, localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance', representedPayload: retained }),
    }
    const report = createEBalanceReport(profile, taxonomy, facts, [], attachments, mutatingSerializer)
    expect(report.payload.gcd.tenantId).toBe(tenantId)
    expect(Object.isFrozen(report.payload)).toBe(true)
    expect(Object.isFrozen(report.payload.gcd)).toBe(true)
    expect(retained).not.toBe(report.payload)
    expect((retained!.gcd as { tenantId: string }).tenantId).toBe(tenantId)
  })

  it('rejects malformed current taxonomy versions before string normalization', () => {
    expect(() => planTaxonomyUpgrade([taxonomy], null as never)).toThrow('numeric dotted grammar')
    expect(() => planTaxonomyUpgrade([taxonomy], '   ')).toThrow('numeric dotted grammar')
  })
})
