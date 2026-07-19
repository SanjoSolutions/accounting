import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

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
  await prisma.companyProfileVersion.create({ data: { id: 'profile-a', ownerId: 'tenant-a', effectiveFrom: new Date('2026-01-01'), effectiveTo: new Date('2026-12-31'), payload: JSON.stringify({ companyName: 'Tenant GmbH', legalForm: 'GMBH', taxNumber: '12/345/67890', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Software', sizeClass: 'SMALL', chart: 'SKR03', elections: [] }), createdBy: 'tester', reason: 'test' } })
  const fiscalYear = await prisma.fiscalYear.create({ data: { id: 'fy-a', ownerId: 'tenant-a', year: 2026, startsAt: new Date('2026-01-01'), endsAt: new Date('2026-12-31') } })
  const account = await prisma.ledgerAccount.create({ data: { id: 'vat-output', ownerId: 'tenant-a', number: 1776, name: 'Umsatzsteuer 19%', category: 'LIABILITY', eBilanzPosition: 'bs.eqLiab.liab.other.theroffTax.vat' } })
  await prisma.ledgerAccount.create({ data: { id: 'vat-input', ownerId: 'tenant-a', number: 1576, name: 'Vorsteuer 19%', category: 'ASSET', eBilanzPosition: 'bs.ass.currAss.receiv.other.vat' } })
  const baseAccount = await prisma.ledgerAccount.create({ data: { id: 'base-account', ownerId: 'tenant-a', number: 8400, name: 'Revenue', category: 'REVENUE' } })
  await prisma.journalEntry.create({ data: { id: 'entry-a', sequenceNumber: 1, bookingDate: new Date('2026-01-02'), documentNumber: 'INV-1', description: 'VAT', fiscalYearId: fiscalYear.id, state: 'DRAFT', lines: { create: [{ id: 'line-a', accountId: baseAccount.id, creditCents: 10000 }, { id: 'line-control', accountId: account.id, creditCents: 1900 }] } } })
  await prisma.journalLine.create({ data: { id: 'line-b', journalEntryId: 'entry-a', accountId: baseAccount.id, creditCents: 10000 } })
  await prisma.journalEntry.create({ data: { id: 'entry-posted', sequenceNumber: 2, bookingDate: new Date('2026-01-03'), documentNumber: 'INV-2', description: 'Posted', fiscalYearId: fiscalYear.id, lines: { create: { id: 'line-posted', accountId: baseAccount.id, creditCents: 10000 } } } })
  await prisma.documentRecord.create({ data: { id: 'document-a', ownerId: 'tenant-a', payload: '{}' } })
})
afterAll(async () => { await prisma.$disconnect(); delete process.env.DATABASE_URL; rmSync(directory, { recursive: true, force: true }) })

describe('persistent VAT detail and reconciliation integration', () => {
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
    await prisma.journalEntry.update({ where: { id: 'entry-a' }, data: { state: 'DRAFT' } })
    const transaction = prisma.$transaction.bind(prisma)
    const race = vi.spyOn(prisma, '$transaction').mockImplementationOnce(async callback => {
      await prisma.journalEntry.update({ where: { id: 'entry-a' }, data: { state: 'POSTED' } })
      return transaction(callback)
    })
    await expect(api.persistVatPosting('tenant-a', { sourceId: 'source-race', amountCents: 10000, mode: 'net', taxPoint: '2026-01-04', ruleId: 'DE_STANDARD', direction: 'sale', journalLineId: 'line-b' })).rejects.toThrow(/became posted or changed/)
    expect(await prisma.vatPostingRecord.findUnique({ where: { ownerId_sourceId: { ownerId: 'tenant-a', sourceId: 'source-race' } } })).toBeNull()
    race.mockRestore()
    await prisma.journalEntry.update({ where: { id: 'entry-a' }, data: { state: 'DRAFT' } })
  })
  it('returns an immutable idempotent result after its linked entry is posted', async () => {
    await prisma.journalEntry.update({ where: { id: 'entry-a' }, data: { state: 'POSTED' } })
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
  it('fails closed when the effective profile does not authorize monthly advance VAT returns', async () => {
    const row = await prisma.companyProfileVersion.findUniqueOrThrow({ where: { id: 'profile-a' } })
    const quarterly = { ...JSON.parse(row.payload), vatFilingFrequency: 'QUARTERLY' }
    await prisma.companyProfileVersion.update({ where: { id: 'profile-a' }, data: { payload: JSON.stringify(quarterly) } })
    await expect(api.prepareReconciledVatDataset('tenant-a', '2026-01')).rejects.toThrow(/STANDARD.*MONTHLY/)
    await prisma.companyProfileVersion.update({ where: { id: 'profile-a' }, data: { payload: row.payload } })
  })
})
