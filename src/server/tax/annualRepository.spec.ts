import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ profile: vi.fn(), fiscalYear: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: { fiscalYear: { findFirst: mocks.fiscalYear } } }))
vi.mock('./profileRepository', () => ({ companyProfileForPeriod: mocks.profile }))

import { annualTaxApplicability, deriveAnnualResultEntryIds, extractEBilanzNetIncomeCents, independentAnnualResults, parseTaxAdjustmentInput, validateEBilanzReferences } from './annualRepository'

describe('annual tax adjustment input', () => {
  it('rejects malformed JSON objects with a client validation error instead of dereferencing missing fields', () => {
    expect(() => parseTaxAdjustmentInput({})).toThrow(/identifiers/)
    expect(() => parseTaxAdjustmentInput({ id: 'a', ruleVersion: '2026.1', field: 'profit', layer: 'income-tax', amountCents: 1.5, reason: 'timing', sourceDocumentIds: ['document-a'], legalBasis: 'rule', treatment: 'add-back' })).toThrow(/integer cents/)
    expect(() => parseTaxAdjustmentInput({ id: 'a', ruleVersion: '2026.1', field: 'profit', layer: 'income-tax', amountCents: 2_147_483_648, reason: 'timing', sourceDocumentIds: ['document-a'], legalBasis: 'rule', treatment: 'add-back' })).toThrow(/32-bit/)
  })

  it('accepts a complete, immutable-document-backed adjustment shape', () => {
    const adjustment = { id: 'adjustment-a', ruleVersion: '2026.1', field: 'profit', layer: 'income-tax' as const, amountCents: 100, reason: 'timing', sourceDocumentIds: ['document-a'], legalBasis: 'rule', treatment: 'add-back' as const }
    expect(parseTaxAdjustmentInput(adjustment)).toEqual(adjustment)
  })
})

describe('annual tax applicability profile', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.fiscalYear.mockResolvedValue({ startsAt: new Date('2025-10-01T00:00:00.000Z'), endsAt: new Date('2026-09-30T00:00:00.000Z') }) })
  it('fails closed when canonical annual filing facts have not been configured', async () => {
    mocks.profile.mockResolvedValue({ legalForm: 'GMBH' })
    await expect(annualTaxApplicability('tenant-a', 2026)).rejects.toThrow(/canonical trade-business/)
  })
  it('uses stored tenant facts for obligations and adviser-adjusted deadlines', async () => {
    mocks.profile.mockResolvedValue({ legalForm: 'GMBH', annualTaxProfile: { tradeBusiness: true, establishments: 2, adviserExtension: true } })
    await expect(annualTaxApplicability('tenant-a', 2026)).resolves.toMatchObject({ profile: { establishments: 2, adviserExtension: true, fiscalYearEnd: '2026-09-30' }, kinds: ['KST', 'GEWST', 'ZERLEGUNG'], deadline: '2028-02-29' })
  })
  it('rejects a generic partnership instead of coercing it to a different legal form', async () => {
    mocks.profile.mockResolvedValue({ legalForm: 'PARTNERSHIP', annualTaxProfile: { tradeBusiness: true, establishments: 1, adviserExtension: false } })
    await expect(annualTaxApplicability('tenant-a', 2026)).rejects.toThrow(/PARTNERSHIP.*not supported/)
  })
})

describe('independent annual result sources', () => {
  it('keeps HGB, ledger and E-Bilanz results independent for reconciliation', () => {
    const values = [
      { field: 'HGB_RESULT', amountCents: 100, ledgerEntryIds: ['entry'], eBilanzFacts: [], adjustmentIds: [] },
      { field: 'E_BILANZ_RESULT', amountCents: 90, ledgerEntryIds: [], eBilanzFacts: ['fact'], adjustmentIds: [] },
    ]
    expect(independentAnnualResults(values, 80)).toEqual({ hgbResultCents: 100, ledgerResultCents: 80, eBilanzResultCents: 90 })
  })
  it('accepts an empty HGB ledger drilldown only for an exact zero-activity result', () => {
    const values = [
      { field: 'HGB_RESULT', amountCents: 0, ledgerEntryIds: [], eBilanzFacts: [], adjustmentIds: [] },
      { field: 'E_BILANZ_RESULT', amountCents: 0, ledgerEntryIds: [], eBilanzFacts: ['fact'], adjustmentIds: [] },
    ]
    expect(independentAnnualResults(values, 0)).toEqual({ hgbResultCents: 0, ledgerResultCents: 0, eBilanzResultCents: 0 })
    expect(() => independentAnnualResults([{ ...values[0], amountCents: 1 }, values[1]], 1)).toThrow(/independently sourced/)
  })
  it('derives exact cents from the persisted E-Bilanz net-income fact', () => {
    const xml = '<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:de-gaap-ci="http://www.xbrl.de/taxonomies/de-gaap-ci-2026-04-01"><!-- <de-gaap-ci:is.netIncome>999.99</de-gaap-ci:is.netIncome> --><de-gaap-ci:is.netIncome contextRef="duration"> -123.4 </de-gaap-ci:is.netIncome></xbrli:xbrl>'
    expect(extractEBilanzNetIncomeCents(xml)).toBe(-12340)
    expect(() => extractEBilanzNetIncomeCents(xml.replace('-123.4', '-123.456'))).toThrow(/exactly in cents/)
  })
  it('rejects nested canonical net-income facts instead of accepting the inner value', () => {
    const nested = '<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:de-gaap-ci="http://www.xbrl.de/taxonomies/de-gaap-ci-2026-04-01"><de-gaap-ci:is.netIncome>1<de-gaap-ci:is.netIncome>2</de-gaap-ci:is.netIncome></de-gaap-ci:is.netIncome></xbrli:xbrl>'
    expect(() => extractEBilanzNetIncomeCents(nested)).toThrow(/well-formed namespace-aware XML/)
  })
  it('rejects any unauthenticated E-Bilanz provenance reference regardless of annual field', () => {
    expect(() => validateEBilanzReferences(['owned-hash', 'cross-tenant-hash'], ['owned-hash'])).toThrow(/tenant-owned/)
    expect(() => validateEBilanzReferences(['owned-hash'], ['owned-hash', 'owned-hash'])).not.toThrow()
  })
  it('derives annual result provenance from every revenue and expense ledger entry only', () => {
    const entries = [
      { id: 'revenue-entry', state: 'POSTED', lines: [{ debitCents: 0, creditCents: 100, account: { category: 'REVENUE' } }] },
      { id: 'expense-entry', state: 'POSTED', lines: [{ debitCents: 20, creditCents: 0, account: { category: 'EXPENSE' } }] },
      { id: 'draft-entry', state: 'DRAFT', lines: [{ debitCents: 10, creditCents: 0, account: { category: 'EXPENSE' } }] },
      { id: 'balance-entry', state: 'POSTED', lines: [{ debitCents: 80, creditCents: 0, account: { category: 'ASSET' } }] },
    ]
    expect(deriveAnnualResultEntryIds(entries)).toEqual(['expense-entry', 'revenue-entry'])
  })
})
