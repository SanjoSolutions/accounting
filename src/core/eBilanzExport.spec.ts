import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, test } from 'vitest'
import { createAuthoritativeEBalanceDataset, eBalanceChecksum, reconciliationChecksum } from './eBilanzExport'
import { eBilanz2026Fixture } from './fixtures/eBilanz2026'
import { OFFICIAL_E_BALANCE_TAXONOMIES, selectOfficialEBalanceTaxonomy } from './eBilanzTaxonomy'
import { readEBalanceTaxonomy, type EBalanceTaxonomyModel } from './eBilanzTaxonomyModel'
import { serializeEBalanceFilingXml } from './eBilanzFilingXml'
import { validateEBalanceFilingXml, validateEBalanceInstanceStructure } from '@/server/compliance/eBilanzSchemaValidation'
import { createEBalancePackage } from './eBilanzPackage'
import { strFromU8, unzipSync } from 'fflate'

let archive: Uint8Array
let model: EBalanceTaxonomyModel
beforeAll(async () => {
  archive = await readFile('public/taxonomies/german-gaap-taxonomy-v6.9-2025-04-01-xbrl.zip')
  model = readEBalanceTaxonomy(OFFICIAL_E_BALANCE_TAXONOMIES[0], archive)
})

describe('authoritative 2026 tax-balance export', () => {
  test('given the independent UG fixture, reconciles exact signed tax facts, reserve and all account details', async () => {
    const dataset = createAuthoritativeEBalanceDataset(eBilanz2026Fixture(), model)
    expect(dataset.totals).toEqual({ commercialNetIncomeCents: 55000, taxNetIncomeCents: 50000, taxAdjustmentCents: -5000, assetsCents: 150000, liabilitiesCents: 0, equityCents: 150000 })
    const fact = (concept: string) => dataset.facts.find(f => f.concept === concept)?.amountCents
    expect(fact('bs.eqLiab.equity.revenueRes.legal')).toBe(10000)
    expect(fact('bs.eqLiab.equity.retainedEarnings')).toBe(-10000)
    expect(fact('bs.eqLiab.equity.netIncome')).toBe(50000)
    expect(dataset.accounts.find(a => a.accountId === 'bank-inactive')?.amountCents).toBe(55000)
    expect(dataset.accounts.find(a => a.accountId === 'revenue-refund')?.amountCents).toBe(-5000)
    expect(dataset.accounts.find(a => a.accountId === 'accumulated-depreciation')?.amountCents).toBe(-25000)
    const xml = serializeEBalanceFilingXml(dataset)
    expect(xml).toContain('legalStatus.UG')
    expect(xml).toContain('accountingStandard.S')
    expect(xml).toContain('2026-04-01')
    expect(xml).toContain('2027-03-31')
    expect(xml).toContain('>950.00</de-gaap-ci:all>')
    expect(xml).toContain('reportElements.BAL contextRef="duration"></')
    expect(xml).not.toContain('reportElements.AV')
    expect(xml).not.toContain('accounting:')
    expect(xml).not.toContain('ABSCHLUSS-')
    expect(xml.match(/<de-gaap-ci:detailedInformation.accountBalances>/g)).toHaveLength(9)
    await expect(validateEBalanceFilingXml(xml, dataset, archive)).resolves.toMatchObject({ valid: true, level: 'LOCAL_STRUCTURAL', officialAcceptance: 'NOT_VALIDATED', closeGenerationId: 'close-2026-v1' })
  }, 15000)

  test('given explicit zero tax differences, exports a complete tax balance and never infers approval', () => {
    const fixture = eBilanz2026Fixture()
    fixture.reconciliation.payload.adjustments = []
    fixture.assets[0].tax = structuredClone(fixture.assets[0].book)
    fixture.reconciliation.checksum = reconciliationChecksum(fixture.ownerId, fixture.fiscalYear.id, fixture.reconciliation.payload, fixture.reconciliation.evidenceIds)
    const dataset = createAuthoritativeEBalanceDataset(fixture, model)
    expect(dataset.totals.taxAdjustmentCents).toBe(0)
    expect(dataset.totals.taxNetIncomeCents).toBe(55000)
    expect(dataset.assets[0].tax.carryingAmountCents).toBe(100000)
  })

  test('given missing mappings, unreconciled assets or BVV, rejects a filing dataset', () => {
    for (const invalid of ['mapping', 'asset', 'bvv', 'journal', 'period', 'nil'] as const) {
      const fixture = eBilanz2026Fixture()
      if (invalid === 'mapping') fixture.balances[0].eBilanzPosition = null
      if (invalid === 'asset') fixture.assets[0].tax.carryingAmountCents++
      if (invalid === 'bvv') fixture.reconciliation.payload.bvv.openingEquityCents++
      if (invalid === 'journal') fixture.reconciliation.payload.adjustments[0].lines[0].debitCents++
      if (invalid === 'period') fixture.fiscalYear.endsAt = '2027-04-01'
      if (invalid === 'nil') delete fixture.reconciliation.payload.nilReasons['company.businessId']
      fixture.reconciliation.checksum = reconciliationChecksum(fixture.ownerId, fixture.fiscalYear.id, fixture.reconciliation.payload, fixture.reconciliation.evidenceIds)
      expect(() => serializeEBalanceFilingXml(createAuthoritativeEBalanceDataset(fixture, model))).toThrow()
    }
  })

  test('given a corrected approval with identical tax facts, binds distinct XML bytes to the new dataset', () => {
    const fixture = eBilanz2026Fixture()
    const original = serializeEBalanceFilingXml(createAuthoritativeEBalanceDataset(fixture, model))
    fixture.reconciliation.payload.nilReasons['company.businessId'] = 'Corrected documentary explanation.'
    fixture.reconciliation.checksum = reconciliationChecksum(fixture.ownerId, fixture.fiscalYear.id, fixture.reconciliation.payload, fixture.reconciliation.evidenceIds)
    const corrected = serializeEBalanceFilingXml(createAuthoritativeEBalanceDataset(fixture, model))
    expect(eBalanceChecksum(corrected)).not.toBe(eBalanceChecksum(original))
    expect(corrected.replace(/<!-- dataset-sha256:[a-f0-9]+ -->/, '')).toBe(original.replace(/<!-- dataset-sha256:[a-f0-9]+ -->/, ''))
  })

  test('given forged namespaces, periods, units, duplicate or absent facts, rejects structural validation', () => {
    const dataset = createAuthoritativeEBalanceDataset(eBilanz2026Fixture(), model)
    const xml = serializeEBalanceFilingXml(dataset)
    const attacks = [
      xml.replace(dataset.taxonomy.gaapNamespace, 'urn:private-evidence'),
      xml.replace('<xbrli:instant>2027-03-31', '<xbrli:instant>2026-12-31'),
      xml.replace('unitRef="EUR"', 'unitRef="USD"'),
      xml.replace(/<de-gaap-ci:bs.ass [^>]+>[^<]+<\/de-gaap-ci:bs.ass>/, ''),
      xml.replace('</xbrli:xbrl>', '<de-gaap-ci:bs.ass contextRef="instant" unitRef="EUR" decimals="2">1500.00</de-gaap-ci:bs.ass></xbrli:xbrl>'),
      xml.replace('<?xml version="1.0" encoding="UTF-8"?>', '<!DOCTYPE xbrl [<!ENTITY secret SYSTEM "file:///private">]>'),
    ]
    for (const attack of attacks) expect(() => validateEBalanceInstanceStructure(attack, dataset, model)).toThrow()
  })

  test('given an XSD-invalid monetary value, uses real schema validation to reject the instance', async () => {
    const dataset = createAuthoritativeEBalanceDataset(eBilanz2026Fixture(), model)
    const xml = serializeEBalanceFilingXml(dataset).replace('>1500.00</de-gaap-ci:bs.ass>', '>not-a-decimal</de-gaap-ci:bs.ass>')
    await expect(validateEBalanceFilingXml(xml, dataset, archive)).rejects.toThrow('Official taxonomy XSD validation failed')
  }, 15000)

  test('given a validation package, preserves exact XML, official schema bytes and companion evidence', () => {
    const dataset = createAuthoritativeEBalanceDataset(eBilanz2026Fixture(), model)
    const xml = serializeEBalanceFilingXml(dataset)
    const packageFiles = unzipSync(createEBalancePackage(xml, 2026, archive, { 'export-data.json': JSON.stringify(dataset) }))
    expect(strFromU8(packageFiles['e-bilanz-2026.xbrl'])).toBe(xml)
    expect(JSON.parse(strFromU8(packageFiles['export-data.json']))).toEqual(dataset)
    expect(packageFiles[model.release.entryPoint]).toEqual(unzipSync(archive)[model.release.entryPoint])
    expect(() => createEBalancePackage(xml, 2026, archive, { '../escape': 'unsafe' })).toThrow()
  })

  test('given missing or stale reconciliation, refuses a filing-ready dataset', () => {
    for (const change of ['generation', 'tenant', 'checksum', 'incomplete'] as const) {
      const fixture = eBilanz2026Fixture()
      if (change === 'generation') fixture.reconciliation.payload.closeGenerationId = 'old-close'
      if (change === 'tenant') fixture.reconciliation.ownerId = 'another-tenant'
      if (change === 'checksum') fixture.reconciliation.checksum = '0'.repeat(64)
      if (change === 'incomplete') (fixture.reconciliation.payload as { complete: boolean }).complete = false
      expect(() => createAuthoritativeEBalanceDataset(fixture, model)).toThrow()
    }
  })

  test('given corrupted official bytes, refuses schema use', () => {
    expect(() => readEBalanceTaxonomy(OFFICIAL_E_BALANCE_TAXONOMIES[0], new Uint8Array([1, 2]))).toThrow('checksum')
  })

  test('given a source mutation after preparation, preserves immutable dataset values', () => {
    const fixture = eBilanz2026Fixture()
    const dataset = createAuthoritativeEBalanceDataset(fixture, model)
    fixture.company.companyName = 'Changed'
    fixture.balances[0].debitCents = 1
    expect(dataset.company.companyName).toBe('Muster & Test UG (haftungsbeschränkt)')
    expect(Object.isFrozen(dataset.accounts[0])).toBe(true)
  })

  test('given a balanced loss fixture, retains negative result and equity without absolute-value conversion', () => {
    const fixture = eBilanz2026Fixture()
    const revenue = fixture.balances.find(a => a.accountId === 'revenue')!
    revenue.creditCents = 10000; revenue.balanceCents = -10000
    const bank = fixture.balances.find(a => a.accountId === 'bank-inactive')!
    bank.debitCents = 0; bank.creditCents = 15000; bank.balanceCents = -15000
    const dataset = createAuthoritativeEBalanceDataset(fixture, model)
    expect(dataset.totals.taxNetIncomeCents).toBe(-20000)
    expect(dataset.totals.equityCents).toBe(80000)
  })
})

describe('official taxonomy receiver selection', () => {
  test('given October 2026, selects the available 6.9 baseline and rejects announced 6.10', () => {
    expect(selectOfficialEBalanceTaxonomy('2026-04-01', { asOf: '2026-10-13' }).version).toBe('6.9')
    expect(() => selectOfficialEBalanceTaxonomy('2026-04-01', { asOf: '2026-10-13', requestedVersion: '6.10' })).toThrow('receiver-available')
    expect(() => selectOfficialEBalanceTaxonomy('2027-01-01', { asOf: '2027-05-01' })).toThrow()
    expect(() => selectOfficialEBalanceTaxonomy('2026-02-30', { asOf: '2026-10-13' })).toThrow('real date')
    expect(() => selectOfficialEBalanceTaxonomy('2026-01-01', { asOf: '2026-04-30' })).toThrow()
    expect(() => selectOfficialEBalanceTaxonomy('2026-01-01', { asOf: '2027-06-01', requestedVersion: '6.10' })).toThrow()
  })
})
