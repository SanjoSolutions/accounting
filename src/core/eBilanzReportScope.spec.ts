import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { createAuthoritativeEBalanceDataset, reconciliationChecksum, validateTaxBalanceEvidence, type EBalanceExportInput } from './eBilanzExport'
import { eBilanz2026Fixture } from './fixtures/eBilanz2026'
import { OFFICIAL_E_BALANCE_TAXONOMIES, selectOfficialEBalanceTaxonomy } from './eBilanzTaxonomy'
import { readEBalanceTaxonomy, type EBalanceTaxonomyModel } from './eBilanzTaxonomyModel'
import { planEBalanceTaxonomyUpgrade } from './eBilanzTaxonomyUpgrade'
import { E_BALANCE_ATTACHMENT_KINDS, E_BALANCE_CORPORATE_ANNUAL_FORM, deriveEBalanceReportScope, type EBalanceReportProfile } from './eBilanzReportScope'
import { serializeEBalanceFilingXml } from './eBilanzFilingXml'
import { validateEBalanceFilingXml } from '@/server/compliance/eBilanzSchemaValidation'
import { parseEBalanceXml, xmlDescendants, XMLNS } from './eBilanzXml'

let model69: EBalanceTaxonomyModel
let model610: EBalanceTaxonomyModel
const archives = OFFICIAL_E_BALANCE_TAXONOMIES.map(release => readFileSync(`public/taxonomies/${release.archiveFile}`))
beforeAll(() => {
  model69 = readEBalanceTaxonomy(OFFICIAL_E_BALANCE_TAXONOMIES[0], archives[0])
  model610 = readEBalanceTaxonomy(OFFICIAL_E_BALANCE_TAXONOMIES[1], archives[1])
})
function approve(fixture: EBalanceExportInput) {
  fixture.reconciliation.checksum = reconciliationChecksum(fixture.ownerId, fixture.fiscalYear.id, fixture.reconciliation.payload, fixture.reconciliation.evidenceIds)
  return fixture
}
function fixtureV2() {
  const fixture = eBilanz2026Fixture()
  const payload = fixture.reconciliation.payload
  payload.schemaVersion = 'EBILANZ_TAX_BALANCE_V2'
  payload.adjustments[0].classification = { kind: 'TEMPORARY', reversalExpectedThrough: '2030-03-31' }
  payload.revision = { status: 'E', reason: 'Initial synthetic report', supersedes: null }
  payload.attachments = E_BALANCE_ATTACHMENT_KINDS.map(kind => ({ kind, status: 'NOT_APPLICABLE', reason: 'Not applicable to this synthetic fixture.' }))
  return approve(fixture)
}

describe('official taxonomy upgrade lifecycle', () => {
  test('given the published 6.10 archive, allows explicit local preparation but never infers receiver availability from elapsed time', () => {
    expect(selectOfficialEBalanceTaxonomy('2026-04-01', { asOf: '2026-10-15', receiver: 'LOCAL', requestedVersion: '6.10' })).toMatchObject({ archiveSha256: model610.release.archiveSha256, receiverVerifiedOn: null })
    for (const receiver of ['TEST', 'LIVE'] as const) {
      expect(() => selectOfficialEBalanceTaxonomy('2026-04-01', { asOf: '2030-01-01', receiver, requestedVersion: '6.10' })).toThrow('receiver-available')
    }
    expect(() => selectOfficialEBalanceTaxonomy('2026-04-01', { asOf: '2026-06-07', receiver: 'LOCAL', requestedVersion: '6.10' })).toThrow()
    expect(() => selectOfficialEBalanceTaxonomy('2025-04-01', { asOf: '2026-10-15', receiver: 'LOCAL', requestedVersion: '6.10' })).toThrow()
  })

  test('given a retained 6.9 dataset, reports real official changes and creates a separately validated 6.10 instance', async () => {
    const fixture = fixtureV2()
    const before = createAuthoritativeEBalanceDataset(fixture, model69)
    const retainedXml = serializeEBalanceFilingXml(before)
    const plan = planEBalanceTaxonomyUpgrade(before, model69, model610)
    expect(plan.blockers).toEqual([])
    expect(plan.newlyRequiredConcepts).toContain('gaap:is.netIncome.otherTaxes.GrSt')
    expect(plan.requiresNewValidation).toBe(true)
    const after = createAuthoritativeEBalanceDataset(fixture, model610)
    expect(after.totals).toEqual(before.totals)
    const xml = serializeEBalanceFilingXml(after)
    expect(xml).not.toContain('transmissionNotYetPossible')
    expect(xml).toContain('shareholder.idNotAssigned')
    await expect(validateEBalanceFilingXml(xml, after, archives[1])).resolves.toMatchObject({ valid: true, officialAcceptance: 'NOT_VALIDATED' })
    expect(serializeEBalanceFilingXml(before)).toBe(retainedXml)
  }, 60000)

  test('given a removed or sign-changed mapping, requires human remapping instead of changing account semantics', () => {
    const dataset = createAuthoritativeEBalanceDataset(fixtureV2(), model69)
    const concepts = new Map(model610.concepts)
    concepts.delete(`gaap:${dataset.accounts[0].concept}`)
    const key = `gaap:${dataset.accounts.find(a => a.accountId === 'capital')!.concept}`
    concepts.set(key, { ...concepts.get(key)!, balance: 'debit' })
    const plan = planEBalanceTaxonomyUpgrade(dataset, model69, { ...model610, concepts })
    expect(plan.blockers.map(row => row.accountId)).toContain(dataset.accounts[0].accountId)
    expect(plan.blockers.map(row => row.accountId)).toContain('capital')
    expect(() => planEBalanceTaxonomyUpgrade(dataset, model69, model69)).toThrow('later')
    expect(() => planEBalanceTaxonomyUpgrade(dataset, model610, model69)).toThrow('source')
  })

  test('given no assigned shareholder identifier in 6.10, requires explicit documented non-assignment', () => {
    const fixture = fixtureV2()
    const shareholder = fixture.reconciliation.payload.gcd.shareholders[0]
    shareholder.taxId = null
    fixture.reconciliation.payload.nilReasons['shareholder.owner-1.taxId'] = 'Not assigned.'
    expect(() => createAuthoritativeEBalanceDataset(approve(fixture), model610)).toThrow('shareholder identifier')
    shareholder.identifiersNotAssigned = true
    fixture.reconciliation.payload.nilReasons['shareholder.owner-1.identifiersNotAssigned'] = 'Documented synthetic non-assignment.'
    expect(serializeEBalanceFilingXml(createAuthoritativeEBalanceDataset(approve(fixture), model610))).toContain('shareholder.idNotAssigned contextRef="duration"></')
    shareholder.taxId = '12345678901'
    expect(() => createAuthoritativeEBalanceDataset(approve(fixture), model610)).toThrow('contradicts')
  })
})

describe('explicit corporate report scope and reconciliation', () => {
  test('given every registered release, verifies the supported legal and revision form codes against official declarations', () => {
    for (const model of [model69, model610]) {
      for (const legalForm of E_BALANCE_CORPORATE_ANNUAL_FORM.legalForms) expect(model.concepts.get(`gcd:genInfo.company.id.legalStatus.legalStatus.${legalForm}`)).toMatchObject({ abstract: false, prohibited: false })
      for (const status of E_BALANCE_CORPORATE_ANNUAL_FORM.revisionStatuses) expect(model.concepts.get(`gcd:genInfo.report.id.revisionStatus.revisionStatus.${status}`)).toMatchObject({ abstract: false, prohibited: false })
    }
    expect(() => deriveEBalanceReportScope('UG', undefined, '6.11')).toThrow('not been reviewed')
  })

  test.each(['UG', 'GMBH', 'AG'] as const)('given an ordinary domestic %s, emits an official tax balance and individual asset register', async legalForm => {
    const fixture = fixtureV2()
    fixture.company.legalForm = legalForm
    const dataset = createAuthoritativeEBalanceDataset(fixture, model69)
    expect(dataset.reportScope).toMatchObject({ legalForm, accountingStandard: 'S', incomeStatementMethod: 'GKV' })
    expect(dataset.adjustmentDetails).toEqual([{ id: 'tax-depreciation', classification: { kind: 'TEMPORARY', reversalExpectedThrough: '2030-03-31' }, profitEffectCents: -5000 }])
    const xml = serializeEBalanceFilingXml(dataset)
    expect(xml).toContain(`legalStatus.${legalForm}`)
    expect(xml).toContain('reportElements.AV')
    expect(xml).toContain('Buchwert steuerlich (EUR): 950.00')
    await expect(validateEBalanceFilingXml(xml, dataset, archives[0])).resolves.toMatchObject({ valid: true, level: 'LOCAL_STRUCTURAL' })
  }, 60000)

  test('given mixed permanent and temporary journals, reconciles their signed profit effects independently', () => {
    const fixture = fixtureV2()
    fixture.reconciliation.payload.adjustments.push({ id: 'permanent-zero', description: 'Permanent reclassification without profit effect', classification: { kind: 'PERMANENT' }, evidenceIds: ['evidence-gcd'], lines: [
      { accountId: 'capital', debitCents: 1000, creditCents: 0 }, { accountId: 'UG-reserve', debitCents: 0, creditCents: 1000 },
    ] })
    const dataset = createAuthoritativeEBalanceDataset(approve(fixture), model69)
    expect(dataset.adjustmentDetails?.map(row => row.profitEffectCents)).toEqual([-5000, 0])
    expect(dataset.totals.taxAdjustmentCents).toBe(-5000)
  })

  test('given missing classifications, past reversal dates or undeclared attachments, refuses a complete V2 report', () => {
    for (const mutation of ['classification', 'date', 'attachments', 'revision'] as const) {
      const fixture = fixtureV2()
      const payload = fixture.reconciliation.payload
      if (mutation === 'classification') delete payload.adjustments[0].classification
      if (mutation === 'date') payload.adjustments[0].classification = { kind: 'TEMPORARY', reversalExpectedThrough: fixture.fiscalYear.endsAt }
      if (mutation === 'attachments') payload.attachments!.pop()
      if (mutation === 'revision') delete payload.revision
      expect(() => createAuthoritativeEBalanceDataset(approve(fixture), model69)).toThrow()
    }
  })

  test('given an invalid asset-register date or missing description, refuses to serialize an incomplete register', () => {
    for (const change of ['future-date', 'invalid-date', 'description', 'location'] as const) {
      const fixture = fixtureV2()
      if (change === 'future-date') fixture.assets[0].acquisitionDate = '2030-01-01'
      if (change === 'invalid-date') fixture.assets[0].acquisitionDate = '2026-02-30'
      if (change === 'description') fixture.assets[0].book.description = ''
      if (change === 'location') fixture.assets[0].book.location = ''
      expect(() => createAuthoritativeEBalanceDataset(fixture, model69)).toThrow()
    }
  })

  test('given an unsupported report variant or partnership, refuses to silently serialize an ordinary corporate report', () => {
    const profile: EBalanceReportProfile = { accountingStandard: 'HGB', incomeStatementMethod: 'GKV', statementType: 'E', reportStatus: 'E', consolidationRange: 'EA', incomeClassification: 'trade' }
    for (const patch of [{ incomeStatementMethod: 'UKV' }, { statementType: 'PB' }, { consolidationRange: 'KA' }, { specialBalanceRequired: true }, { supplementaryBalanceRequired: true }, { reportStatus: 'F' }]) {
      const fixture = fixtureV2()
      fixture.reportProfile = { ...profile, ...patch }
      expect(() => createAuthoritativeEBalanceDataset(fixture, model69)).toThrow('unsupported')
    }
    expect(() => deriveEBalanceReportScope('KG', profile)).toThrow('domestic')
  })

  test.each(['B', 'G', 'BG', 'I'] as const)('given approved revision %s, binds a predecessor while preserving the old instance', status => {
    const fixture = fixtureV2()
    const original = createAuthoritativeEBalanceDataset(fixture, model69)
    const xml = serializeEBalanceFilingXml(original)
    fixture.reconciliation.payload.revision = { status, reason: 'Approved correction', supersedes: { reportId: 'previous-report', reportChecksum: 'f'.repeat(64) } }
    const revised = createAuthoritativeEBalanceDataset(approve(fixture), model69)
    expect(serializeEBalanceFilingXml(revised)).toContain(`revisionStatus.${status} contextRef`)
    expect(serializeEBalanceFilingXml(original)).toBe(xml)
    fixture.reconciliation.payload.revision.supersedes = null
    expect(() => validateTaxBalanceEvidence(fixture.reconciliation.payload)).toThrow('predecessor')
  })

  test('given attachment text, preserves escaped content in fact-linked footnotes and declares report elements', async () => {
    const fixture = fixtureV2()
    fixture.reconciliation.payload.attachments = E_BALANCE_ATTACHMENT_KINDS.map(kind => ({ kind, status: 'PRESENT', text: `${kind}: A & B < C\nSecond line.`, evidenceIds: ['evidence-gcd'] }))
    expect(() => createAuthoritativeEBalanceDataset(approve(fixture), model69)).toThrow('nt.RegisterEStG5Abs1S2')
    const dataset = createAuthoritativeEBalanceDataset(approve(fixture), model610)
    const xml = serializeEBalanceFilingXml(dataset)
    const nodes = xmlDescendants(parseEBalanceXml(xml))
    const footnotes = nodes.filter(node => node.uri === XMLNS.link && node.local === 'footnote')
    expect(footnotes.map(note => note.text)).toContain('NOTES: A & B < C\nSecond line.')
    expect(footnotes).toHaveLength(5)
    const ids = new Set(nodes.map(node => node.attributes.id).filter(Boolean))
    for (const loc of nodes.filter(node => node.uri === XMLNS.link && node.local === 'loc')) expect(ids.has(loc.attributes[`{${XMLNS.xlink}}href`].slice(1))).toBe(true)
    await expect(validateEBalanceFilingXml(xml, dataset, archives[1])).resolves.toMatchObject({ valid: true })
  }, 60000)
})
