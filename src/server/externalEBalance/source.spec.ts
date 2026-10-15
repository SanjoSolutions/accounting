import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import { canonicalJson } from '@/core/compliance/auditExport'
import { createAuthoritativeEBalanceDataset, eBalanceChecksum } from '@/core/eBilanzExport'
import { serializeEBalanceFilingXml } from '@/core/eBilanzFilingXml'
import { selectOfficialEBalanceTaxonomy } from '@/core/eBilanzTaxonomy'
import { readEBalanceTaxonomy } from '@/core/eBilanzTaxonomyModel'
import { eBilanz2026Fixture } from '@/core/fixtures/eBilanz2026'
import { createExternalPackage, hashBytes, readExternalPackage } from './adapter'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ generation: vi.fn(), prepare: vi.fn(), current: vi.fn() }))
vi.mock('@/server/persistence/client', () => ({ prisma: { fiscalCloseGeneration: { findFirst: mocks.generation } } }))
vi.mock('@/server/compliance/eBilanzExportRepository', () => ({ prepareAuthoritativeEBalanceExport: mocks.prepare, assertCurrentEBalanceExport: mocks.current }))
import { assertCurrentExternalSource, prepareExternalSource } from './source'
import { prisma } from '@/server/persistence/client'

const fixture = eBilanz2026Fixture()
const release = selectOfficialEBalanceTaxonomy(fixture.fiscalYear.startsAt, { asOf: '2027-04-02' })
const officialArchive = readFileSync(`public/taxonomies/${release.archiveFile}`)
const dataset = createAuthoritativeEBalanceDataset(fixture, readEBalanceTaxonomy(release, officialArchive))
const xml = serializeEBalanceFilingXml(dataset)
const prepared = { dataset, datasetChecksum: eBalanceChecksum(canonicalJson(dataset)), xml, officialArchive, evidenceChecksum: fixture.reconciliation.payload.evidenceChecksum, diagnostics: { level: 'LOCAL_STRUCTURAL', valid: true } }

beforeEach(() => {
  vi.resetAllMocks()
  mocks.generation.mockResolvedValue({ id: fixture.closeGeneration.id })
  mocks.prepare.mockResolvedValue(prepared)
})

describe('External adapter consumes the shared authoritative source', () => {
  test('Given an approved off-calendar UG dataset, when packaged, then exact XBRL, commercial accounts, tax adjustments and asset evidence are preserved without ERiC', async () => {
    const source = await prepareExternalSource(fixture.ownerId, fixture.fiscalYear.id)
    expect(mocks.prepare).toHaveBeenCalledWith(fixture.ownerId, fixture.fiscalYear.id)
    const result = createExternalPackage(source, 1)
    const { files, manifest } = readExternalPackage(result.archive, hashBytes(result.archive))
    expect(strFromU8(files['e-bilanz.xbrl'])).toBe(xml)
    expect(strFromU8(unzipSync(files['xbrl-mit-taxonomie.zip'])['e-bilanz-2026.xbrl'])).toBe(xml)
    expect(JSON.parse(strFromU8(files['datengrundlage.json']))).toEqual(dataset)
    expect(source.sourceFingerprint).toBe(prepared.datasetChecksum)
    expect(source.accounts.find(account => account.accountId === 'bank-inactive')?.balanceCents).toBe(55000)
    expect(strFromU8(files['susa.csv'])).toContain('200.00')
    expect(manifest.reconciliation.differenceCents).toBe(0)
    expect(strFromU8(files['myebilanz-mapping.ini.template'])).toContain('fiscalYearEnd=2027-03-31')
    expect(dataset.totals.taxAdjustmentCents).toBe(-5000)
    expect(dataset.assets).toHaveLength(1)
  })
  test('Given no retained close generation, when reading export readiness, then the legacy lazy-write provider is never invoked', async () => {
    mocks.generation.mockResolvedValue(null)
    await expect(prepareExternalSource(fixture.ownerId, fixture.fiscalYear.id)).rejects.toMatchObject({ status: 409 })
    expect(mocks.generation).toHaveBeenCalledWith({ where: { ownerId: fixture.ownerId, fiscalYearId: fixture.fiscalYear.id }, select: { id: true } })
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
  test('Given incomplete or structurally invalid authoritative evidence, when preparing, then no fallback dataset is exported', async () => {
    mocks.prepare.mockRejectedValueOnce(new Error('Missing approved reconciliation'))
    await expect(prepareExternalSource(fixture.ownerId, fixture.fiscalYear.id)).rejects.toThrow('Missing approved reconciliation')
    mocks.prepare.mockResolvedValueOnce({ ...prepared, diagnostics: { level: 'LOCAL_STRUCTURAL', valid: false } })
    await expect(prepareExternalSource(fixture.ownerId, fixture.fiscalYear.id)).rejects.toMatchObject({ status: 409 })
  })
  test('Given a prepared source, when publishing, then the shared close, reconciliation and evidence check runs on the publication transaction and propagates changes', async () => {
    const source = await prepareExternalSource(fixture.ownerId, fixture.fiscalYear.id)
    await assertCurrentExternalSource(fixture.ownerId, source, prisma)
    expect(mocks.current).toHaveBeenCalledWith(prisma, fixture.ownerId, source)
    mocks.current.mockRejectedValueOnce(new Error('Reconciliation evidence changed'))
    await expect(assertCurrentExternalSource(fixture.ownerId, source, prisma)).rejects.toMatchObject({ status: 409, message: 'Reconciliation evidence changed' })
  })
})
