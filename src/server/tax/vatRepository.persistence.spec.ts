import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-vat-repository-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./vatRepository')
let prisma: typeof import('@/server/persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath); const root = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(root, name, 'migration.sql'), 'utf8'))
  database.close(); process.env.DATABASE_URL = `file:${databasePath}`
  api = await import('./vatRepository'); prisma = (await import('@/server/persistence/client')).prisma
  await prisma.companyProfileVersion.create({ data: { id: 'profile-a', ownerId: 'tenant-a', effectiveFrom: new Date('2026-01-01'), effectiveTo: new Date('2026-12-31'), payload: JSON.stringify({ companyName: 'Tenant GmbH', legalForm: 'GMBH', taxNumber: '12/345/67890', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'QUARTERLY', activity: 'Software', sizeClass: 'SMALL', chart: 'SKR03', elections: [] }), createdBy: 'tester', reason: 'test' } })
  const fiscalYear = await prisma.fiscalYear.create({ data: { id: 'fy-a', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') } })
  const account = await prisma.ledgerAccount.create({ data: { id: 'vat-output', ownerId: 'tenant-a', number: 1776, name: 'Umsatzsteuer 19%', category: 'LIABILITY', eBilanzPosition: 'bs.eqLiab.liab.other.theroffTax.vat' } })
  await prisma.ledgerAccount.create({ data: { id: 'vat-output-reduced', ownerId: 'tenant-a', number: 1771, name: 'Umsatzsteuer 7%', category: 'LIABILITY', eBilanzPosition: 'bs.eqLiab.liab.other.theroffTax.vat' } })
  await prisma.ledgerAccount.create({ data: { id: 'vat-input-reduced', ownerId: 'tenant-a', number: 1571, name: 'Vorsteuer 7%', category: 'ASSET', eBilanzPosition: 'bs.ass.currAss.receiv.other.vat' } })
  await prisma.ledgerAccount.create({ data: { id: 'vat-input', ownerId: 'tenant-a', number: 1576, name: 'Vorsteuer 19%', category: 'ASSET', eBilanzPosition: 'bs.ass.currAss.receiv.other.vat' } })
  await prisma.ledgerAccount.createMany({ data: [
    { id: 'vat-input-13b', ownerId: 'tenant-a', number: 1577, name: 'Vorsteuer §13b 19%', category: 'ASSET' },
    { id: 'vat-output-13b', ownerId: 'tenant-a', number: 1787, name: 'Umsatzsteuer §13b 19%', category: 'LIABILITY' },
    { id: 'eu-service-13b', ownerId: 'tenant-a', number: 3123, name: 'EU service §13b 19%', category: 'EXPENSE' },
    { id: 'vendor', ownerId: 'tenant-a', number: 70012, name: 'EU vendor', category: 'LIABILITY' },
    { id: 'expense', ownerId: 'tenant-a', number: 2309, name: 'Expense', category: 'EXPENSE' },
    { id: 'customer', ownerId: 'tenant-a', number: 10011, name: 'Customer', category: 'ASSET' },
  ] })
  await prisma.ledgerProfile.create({ data: { ownerId: 'tenant-a', chart: 'SKR03', accountLength: 4 } })
  const baseAccount = await prisma.ledgerAccount.create({ data: { id: 'base-account', ownerId: 'tenant-a', number: 8400, name: 'Revenue', category: 'REVENUE' } })
  await prisma.journalEntry.create({ data: { id: 'entry-a', ownerId: 'tenant-a', sequenceNumber: 1, bookingDate: new Date('2026-01-02'), documentNumber: 'INV-1', description: 'VAT', fiscalYearId: fiscalYear.id, state: 'DRAFT', lines: { create: [{ id: 'line-a', accountId: baseAccount.id, creditCents: 10000 }, { id: 'line-control', accountId: account.id, creditCents: 1900 }] } } })
  await prisma.journalLine.create({ data: { id: 'line-b', journalEntryId: 'entry-a', accountId: baseAccount.id, creditCents: 10000 } })
  await prisma.journalEntry.create({ data: { id: 'entry-posted', ownerId: 'tenant-a', sequenceNumber: 2, bookingDate: new Date('2026-01-03'), documentNumber: 'INV-2', description: 'Posted', fiscalYearId: fiscalYear.id, lines: { create: { id: 'line-posted', accountId: baseAccount.id, creditCents: 10000 } } } })
  await prisma.documentRecord.create({ data: { id: 'document-a', ownerId: 'tenant-a', payload: '{}' } })
})
afterAll(async () => { await prisma.$disconnect(); delete process.env.DATABASE_URL; rmSync(directory, { recursive: true, force: true }) })

describe('persistent VAT detail and reconciliation integration', () => {
  test('Given identical mapping cohorts during onboarding, when a quarter is checked, then they are not treated as an accounting transition', () => {
    const mapping = (effectiveFrom: string, accountName = 'Input VAT') => ({ accountNumber: 1576, accountName, accountType: 'ASSET', normalBalance: 'DEBIT', presentationSign: 1, hgbPosition: 'HGB.VAT', eBilanzPosition: 'bs.ass.currAss.receiv.other.vat', vatCode: null, active: true, effectiveFrom: new Date(effectiveFrom) })
    expect(api.hasDifferentVatMappingTransition([mapping('2020-01-01'), mapping('2026-08-13')], new Date('2020-01-01').toISOString(), new Date('2026-09-30'))).toBe(false)
    expect(api.hasDifferentVatMappingTransition([mapping('2020-01-01'), mapping('2026-08-13', 'Changed input VAT')], new Date('2020-01-01').toISOString(), new Date('2026-09-30'))).toBe(true)
  })
  test('Given a legacy DATEV input-tax booking without a VAT posting record, when detail is reconstructed, then it exactly explains the posted control amount', () => {
    const detail = api.datevImportedVatDetails('tenant-a', [{
      id: 'datev-entry', source: 'DATEV', bookingDate: new Date('2026-07-01'),
      lines: [
        { id: 'expense', debitCents: 46, creditCents: 0, taxCode: '9', vatPosting: null, account: { number: 2309, category: 'EXPENSE' } },
        { id: 'input-vat', debitCents: 9, creditCents: 0, taxCode: '9', vatPosting: null, account: { number: 1576, category: 'ASSET' } },
        { id: 'vendor', debitCents: 0, creditCents: 55, taxCode: '9', vatPosting: null, account: { number: 70013, category: 'LIABILITY' } },
      ],
    }], [1576], [1776])
    expect(detail).toHaveLength(1)
    expect(detail[0]).toMatchObject({ amountCents: 55, netBaseCents: 46, inputTaxCents: 9, taxCents: 9, returnBoxes: [{ box: '66', value: 'input-tax', direction: 'purchase' }] })
  })
  test('Given a legacy DATEV sale with an explicit VAT split but no tax key, when detail is reconstructed, then it exactly explains the output control amount', () => {
    const detail = api.datevImportedVatDetails('tenant-a', [{
      id: 'domain-sale', source: 'DATEV', bookingDate: new Date('2026-06-25'),
      lines: [
        { id: 'customer', debitCents: 1_299, creditCents: 0, taxCode: null, vatPosting: null, account: { number: 10_011, category: 'ASSET' } },
        { id: 'revenue', debitCents: 0, creditCents: 1_092, taxCode: null, vatPosting: null, account: { number: 8_400, category: 'REVENUE' } },
        { id: 'output-vat', debitCents: 0, creditCents: 207, taxCode: null, vatPosting: null, account: { number: 1_776, category: 'LIABILITY' } },
      ],
    }], [1_576], [1_776])
    expect(detail).toHaveLength(1)
    expect(detail[0]).toMatchObject({ amountCents: 1_299, netBaseCents: 1_092, outputTaxCents: 207, taxCents: 207, returnBoxes: [{ box: '81', value: 'net-base', direction: 'sale' }] })
  })
  test('Given a DATEV EU-service §13b split, when detail is reconstructed, then it produces the filed KZ46, KZ47 and KZ67 facts', () => {
    const detail = api.datevImportedVatDetails('tenant-a', [{
      id: 'google-workspace', source: 'DATEV', bookingDate: new Date('2026-04-30'),
      lines: [
        { id: 'base', debitCents: 680, creditCents: 0, taxCode: null, vatPosting: null, account: { number: 3123, category: 'EXPENSE' } },
        { id: 'vendor', debitCents: 0, creditCents: 680, taxCode: null, vatPosting: null, account: { number: 70012, category: 'LIABILITY' } },
        { id: 'input', debitCents: 129, creditCents: 0, taxCode: null, vatPosting: null, account: { number: 1577, category: 'ASSET' } },
        { id: 'output', debitCents: 0, creditCents: 129, taxCode: null, vatPosting: null, account: { number: 1787, category: 'LIABILITY' } },
      ],
    }], [1576, 1577], [1776, 1787], { chart: 'SKR03', accountLength: 4 })
    expect(detail).toHaveLength(1)
    expect(detail[0]).toMatchObject({ netBaseCents: 680, outputTaxCents: 129, inputTaxCents: 129, returnBoxes: [{ box: '46' }, { box: '47' }, { box: '67' }] })
  })
  test('Given ambiguous or mismatched DATEV tax metadata, when detail is reconstructed, then it fails closed or remains unexplained', () => {
    const entry = { id: 'datev-entry', source: 'DATEV', bookingDate: new Date('2026-07-01'), lines: [
      { id: 'expense', debitCents: 45, creditCents: 0, taxCode: '9', vatPosting: null, account: { number: 2309, category: 'EXPENSE' } },
      { id: 'input-vat', debitCents: 10, creditCents: 0, taxCode: '9', vatPosting: null, account: { number: 1576, category: 'ASSET' } },
      { id: 'vendor', debitCents: 0, creditCents: 55, taxCode: '9', vatPosting: null, account: { number: 70013, category: 'LIABILITY' } },
    ] }
    expect(() => api.datevImportedVatDetails('tenant-a', [entry], [1576], [1776])).toThrow(/does not match its posted control amount/)
    expect(api.datevImportedVatDetails('tenant-a', [{ ...entry, source: 'MANUAL' }], [1576], [1776])).toEqual([])
  })
  it('rejects missing required fields before constructing a Prisma selector', async () => {
    const lookup = vi.spyOn(prisma.vatPostingRecord, 'findUnique')
    await expect(api.persistVatPosting('tenant-a', {})).rejects.toThrow(/requires a source ID/)
    expect(lookup).not.toHaveBeenCalled()
    lookup.mockRestore()
  })
  it('rejects cent inputs outside the database integer range before persistence', async () => {
    await expect(api.persistVatPosting('tenant-a', { sourceId: 'source-overflow', amountCents: 2_147_483_648, mode: 'net', taxPoint: '2026-01-02', ruleId: 'DE_STANDARD' })).rejects.toThrow(/signed-32-bit/)
  })
  it('requires linked ledger and VAT detail dates to use the same monthly tax period', async () => {
    await expect(api.persistVatPosting('tenant-a', { sourceId: 'source-cross-period', amountCents: 10000, mode: 'net', taxPoint: '2026-02-02', ruleId: 'DE_STANDARD', direction: 'sale', journalLineId: 'line-b' })).rejects.toThrow(/same monthly tax period/)
    expect(await prisma.vatPostingRecord.findUnique({ where: { ownerId_sourceId: { ownerId: 'tenant-a', sourceId: 'source-cross-period' } } })).toBeNull()
  })
  it('derives VAT control accounts from the effective chart mapping semantics', () => {
    expect(api.vatControlAccountsFromMappings([
      { accountNumber: 1406, eBilanzPosition: 'bs.ass.currAss.receiv.other.vat' },
      { accountNumber: 3806, eBilanzPosition: 'bs.eqLiab.liab.other.theroffTax.vat' },
      { accountNumber: 4400, eBilanzPosition: 'is.netIncome.regular.operatingTC.grossTradingProfit.totalOutput' },
    ])).toEqual({ inputAccounts: [1406], outputAccounts: [3806] })
    expect(() => api.vatControlAccountsFromMappings([{ accountNumber: 9999, eBilanzPosition: 'custom.unmapped' }])).toThrow(/input-VAT and output-VAT/)
  })
  it('persists reproducible effective-rule facts on both the VAT record and journal line', async () => {
    const detail = await api.persistVatPosting('tenant-a', { sourceId: 'source-a', amountCents: 10000, mode: 'net', taxPoint: '2026-01-02', ruleId: 'DE_STANDARD', direction: 'sale', journalLineId: 'line-a', documentId: 'document-a' })
    expect(detail).toMatchObject({ jurisdiction: 'DE', netBaseCents: 10000, rateBasisPoints: 1900, taxCents: 1900, ruleId: 'DE_STANDARD', reason: expect.any(String), documentId: 'document-a' })
    expect(await prisma.journalLine.findUnique({ where: { id: 'line-a' } })).toMatchObject({ taxPoint: new Date('2026-01-02'), taxJurisdiction: 'DE', netBaseCents: 10000, taxRateBasisPoints: 1900, taxAmountCents: 1900, deductibleTaxCents: 0, taxRuleId: 'DE_STANDARD', taxRuleVersion: 1 })
    await prisma.journalEntry.update({ where: { id: 'entry-a' }, data: { state: 'POSTED' } })
  })
  it('reconciles control accounts and produces entry/document return-box drilldown', async () => {
    const result = await api.reconcileTenantVat('tenant-a', '2026-01-01', '2026-01-31')
    expect(result).toMatchObject({ ok: true, expected: { outputTaxCents: 1900 }, ledger: { outputTaxCents: 1900 } })
    expect(result.boxes.flatMap(box => box.entryIds)).toContain('source-a')
    expect(result.boxes.flatMap(box => box.documentIds)).toContain('document-a')
  })
  it('prepares and persists the reconciled 2026 annual VAT dataset', async () => {
    const result = await api.prepareReconciledAnnualVatDataset('tenant-a', 2026)
    expect(result.dataset).toMatchObject({ kind: 'UST_ANNUAL', period: '2026', taxpayerId: 'tenant-a', formVersion: 'UST_ANNUAL-2026.1', fields: { ZAHLLAST: 1900 } })
    expect(result.dataset.drilldown).toMatchObject({ KZ81: expect.arrayContaining(['source-a', 'document-a']) })
    await expect(prisma.taxDatasetPreparationRecord.findUnique({ where: { ownerId_datasetHash: { ownerId: 'tenant-a', datasetHash: (await import('@/core/taxDeclarations')).declarationDatasetHash(result.dataset) } } })).resolves.toMatchObject({ kind: 'UST_ANNUAL', period: '2026' })
  })
  it('fails closed when no annual VAT form is installed for the requested year', async () => {
    await expect(api.prepareReconciledAnnualVatDataset('tenant-a', 2027)).rejects.toThrow(/Unsupported UST_ANNUAL period 2027/)
  })
  it('rejects canonical-number fallback when persisted ledger semantics conflict', async () => {
    await prisma.ledgerAccount.update({ where: { id: 'vat-output' }, data: { eBilanzPosition: 'bs.eqLiab.liab.other' } })
    await expect(api.reconcileTenantVat('tenant-a', '2026-01-01', '2026-01-31')).rejects.toThrow(/conflict with the canonical tenant chart semantics/)
    await prisma.ledgerAccount.update({ where: { id: 'vat-output' }, data: { eBilanzPosition: 'bs.eqLiab.liab.other.theroffTax.vat' } })
  })
  it('fails closed when persisted chart mappings do not cover the complete VAT period', async () => {
    await prisma.accountMappingVersion.create({ data: { ownerId: 'tenant-a', chartId: 'SKR03', accountNumber: 1776, effectiveFrom: new Date('2026-01-15'), accountName: 'Umsatzsteuer', accountType: 'LIABILITY', normalBalance: 'CREDIT', hgbPosition: 'HGB.266', eBilanzPosition: 'bs.eqLiab.liab.other.theroffTax.vat', vatCode: 'U19' } })
    await expect(api.reconcileTenantVat('tenant-a', '2026-01-01', '2026-01-31')).rejects.toThrow(/complete VAT filing period/)
    await prisma.accountMappingVersion.deleteMany({ where: { ownerId: 'tenant-a' } })
  })
  it('rejects cross-tenant journal/document attachment attempts', async () => {
    await expect(api.persistVatPosting('tenant-b', { sourceId: 'source-b', amountCents: 10000, mode: 'net', taxPoint: '2026-01-02', ruleId: 'DE_STANDARD', direction: 'sale', journalLineId: 'line-a', documentId: 'document-a' })).rejects.toThrow(/journal line does not belong/)
  })
  it('does not mutate posted or amount-mismatched journal lines through the sidecar API', async () => {
    await expect(api.persistVatPosting('tenant-a', { sourceId: 'source-posted', amountCents: 10000, mode: 'net', taxPoint: '2026-01-03', ruleId: 'DE_STANDARD', direction: 'sale', journalLineId: 'line-posted' })).rejects.toThrow(/posted journal entry are immutable/)
    await expect(api.persistVatPosting('tenant-a', { sourceId: 'source-mismatch', amountCents: 9000, mode: 'net', taxPoint: '2026-01-02', ruleId: 'DE_STANDARD', direction: 'sale', journalLineId: 'line-b' })).rejects.toThrow(/immutable/)
    expect(await prisma.journalLine.findUnique({ where: { id: 'line-posted' } })).toMatchObject({ taxRuleId: null })
  })
  it('rejects an idempotent source retry with different journal or document provenance', async () => {
    await expect(api.persistVatPosting('tenant-a', { sourceId: 'source-a', amountCents: 10000, mode: 'net', taxPoint: '2026-01-02', ruleId: 'DE_STANDARD', direction: 'sale', journalLineId: 'line-b', documentId: 'document-a' })).rejects.toThrow(/different journal or document provenance/)
    expect(await prisma.journalLine.findUnique({ where: { id: 'line-b' } })).toMatchObject({ taxRuleId: null })
  })
  it('rolls back in-memory reversal markers when the database transaction fails', async () => {
    const transaction = prisma.$transaction.bind(prisma)
    const failure = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(new Error('simulated rollback'))
    const reversal = { sourceId: 'reversal-a', amountCents: 10000, mode: 'net' as const, taxPoint: '2026-02-01', ruleId: 'DE_STANDARD', direction: 'sale' as const, reversalOf: 'source-a', originalTaxPoint: '2026-01-02' }
    await expect(api.persistVatPosting('tenant-a', reversal)).rejects.toThrow(/simulated rollback/)
    failure.mockImplementation(transaction as typeof prisma.$transaction)
    await expect(api.persistVatPosting('tenant-a', reversal)).resolves.toMatchObject({ taxCents: -1900 })
    await expect(api.persistVatPosting('tenant-a', reversal)).resolves.toMatchObject({ taxCents: -1900 })
    failure.mockRestore()
  })

  it('restores reversal dependencies independently of database row order', async () => {
    const rows = await prisma.vatPostingRecord.findMany({ where: { ownerId: 'tenant-a' } })
    const lookup = vi.spyOn(prisma.vatPostingRecord, 'findMany').mockResolvedValueOnce([...rows].reverse())
    await expect(api.reconcileTenantVat('tenant-a', '2026-01-01', '2026-02-28')).resolves.toMatchObject({ expected: { outputTaxCents: 0 } })
    lookup.mockRestore()
  })
  it('atomically rolls back if a linked line becomes posted before the conditional update', async () => {
    await prisma.journalEntry.create({ data: {
      id: 'entry-race', ownerId: 'tenant-a', sequenceNumber: 3, bookingDate: new Date('2026-01-04'), documentNumber: 'INV-RACE', description: 'Concurrent finalization', fiscalYearId: 'fy-a', state: 'DRAFT',
      lines: { create: { id: 'line-race', accountId: 'base-account', creditCents: 10_000 } },
    } })
    const transaction = prisma.$transaction.bind(prisma)
    const race = vi.spyOn(prisma, '$transaction').mockImplementationOnce(async callback => {
      await prisma.journalEntry.update({ where: { id: 'entry-race' }, data: { state: 'POSTED' } })
      return transaction(callback)
    })
    await expect(api.persistVatPosting('tenant-a', { sourceId: 'source-race', amountCents: 10000, mode: 'net', taxPoint: '2026-01-04', ruleId: 'DE_STANDARD', direction: 'sale', journalLineId: 'line-race' })).rejects.toThrow(/became posted or changed/)
    expect(await prisma.vatPostingRecord.findUnique({ where: { ownerId_sourceId: { ownerId: 'tenant-a', sourceId: 'source-race' } } })).toBeNull()
    race.mockRestore()
  })
  it('returns an immutable idempotent result after its linked entry is posted', async () => {
    await expect(api.persistVatPosting('tenant-a', { sourceId: 'source-a', amountCents: 10000, mode: 'net', taxPoint: '2026-01-02', ruleId: 'DE_STANDARD', direction: 'sale', journalLineId: 'line-a', documentId: 'document-a' })).resolves.toMatchObject({ taxCents: 1900 })
  })
  it('reloads the immutable winner after a cross-instance source uniqueness race', async () => {
    const input = { sourceId: 'source-race-winner', amountCents: 10000, mode: 'net' as const, taxPoint: '2026-01-02', ruleId: 'DE_STANDARD', direction: 'sale' as const }
    await api.persistVatPosting('tenant-a', input)
    const lookup = vi.spyOn(prisma.vatPostingRecord, 'findUnique').mockResolvedValueOnce(null)
    const transaction = vi.spyOn(prisma, '$transaction').mockRejectedValueOnce(Object.assign(new Error('unique race'), { code: 'P2002' }))
    await expect(api.persistVatPosting('tenant-a', input)).resolves.toMatchObject({ sourceId: 'source-race-winner', taxCents: 1900 })
    transaction.mockRestore(); lookup.mockRestore()
  })
  it('prepares quarterly advance VAT returns only for an effective quarterly profile', async () => {
    const result = await api.prepareReconciledVatDataset('tenant-a', '2026-Q1')
    expect(result).toMatchObject({ dataset: { period: '2026-Q1', fields: { KZ81: 10_000, KZ83: 1_900, ZAHLLAST: 1_900 } }, copyContext: { companyName: 'Tenant GmbH', taxNumber: '12/345/67890', taxOffice: 'Berlin', filingFrequency: 'QUARTERLY' } })
    await expect(api.prepareReconciledVatDataset('tenant-a', '2026-01')).rejects.toThrow(/Monthly.*MONTHLY/)
  })
  test('Given Q2 DATEV EU services and ordinary VAT splits, when the quarterly return is prepared, then every control reconciles into the correct filed boxes', async () => {
    const createEntry = async (id: string, sequenceNumber: number, bookingDate: string, lines: Array<{ id: string; accountId: string; debitCents?: number; creditCents?: number; taxCode?: string }>) => prisma.journalEntry.create({ data: {
      id, ownerId: 'tenant-a', sequenceNumber, bookingDate: new Date(bookingDate), documentNumber: id, description: id, fiscalYearId: 'fy-a', source: 'DATEV',
      lines: { create: lines },
    } })
    for (const [index, day, base] of [['1', '2026-04-30', 680], ['2', '2026-05-31', 680], ['3', '2026-06-30', 680]] as const) await createEntry(`q2-google-${index}`, 20 + Number(index), day, [
      { id: `q2-google-${index}-base`, accountId: 'eu-service-13b', debitCents: base },
      { id: `q2-google-${index}-vendor`, accountId: 'vendor', creditCents: base },
      { id: `q2-google-${index}-input`, accountId: 'vat-input-13b', debitCents: 129 },
      { id: `q2-google-${index}-output`, accountId: 'vat-output-13b', creditCents: 129 },
    ])
    await createEntry('q2-input', 24, '2026-05-01', [
      { id: 'q2-input-base', accountId: 'expense', debitCents: 3_558, taxCode: '9' },
      { id: 'q2-input-vat', accountId: 'vat-input', debitCents: 676, taxCode: '9' },
      { id: 'q2-input-vendor', accountId: 'vendor', creditCents: 4_234, taxCode: '9' },
    ])
    await createEntry('q2-domain-sale', 25, '2026-06-25', [
      { id: 'q2-domain-customer', accountId: 'customer', debitCents: 1_299 },
      { id: 'q2-domain-revenue', accountId: 'base-account', creditCents: 1_092 },
      { id: 'q2-domain-output', accountId: 'vat-output', creditCents: 207 },
    ])
    const result = await api.prepareReconciledVatDataset('tenant-a', '2026-Q2')
    expect(result.reconciliation.ok).toBe(true)
    expect(result.dataset.fields).toMatchObject({ KZ46: 2_040, KZ47: 387, KZ66: 676, KZ67: 387, KZ81: 1_092, KZ83: -486, ZAHLLAST: -486 })
  })
})
