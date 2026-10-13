import { beforeEach, describe, expect, test, vi } from 'vitest'
import golden from '@/core/compliance/fixtures/hgb-annual-golden.json'

const mocks = vi.hoisted(() => ({
  packages: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  fiscal: { findFirst: vi.fn() }, retained: { create: vi.fn() },
  current: vi.fn(), source: vi.fn(), bytes: vi.fn(), persist: vi.fn(), remove: vi.fn(), audit: vi.fn(), transaction: vi.fn(),
}))
vi.mock('server-only', () => ({}))
vi.mock('@/server/persistence/client', () => ({ prisma: { compliancePackage: mocks.packages, fiscalYear: mocks.fiscal, $transaction: mocks.transaction } }))
vi.mock('./annualReportingSource', () => ({ assertCurrentAnnualPackage: mocks.current, loadAuthoritativeAnnualSource: mocks.source }))
vi.mock('./retainedReportingPackage', async original => ({ ...await original<typeof import('./retainedReportingPackage')>(), readRetainedReportingPackage: mocks.bytes }))
vi.mock('./objectStorage', () => ({ persistComplianceObject: mocks.persist }))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({ delete: mocks.remove }) }))
vi.mock('./auditPersistence', () => ({ appendAuditEvent: mocks.audit }))
import { approveReportingPackage, createDomainReportingPackage } from './reportingRepository'

describe('independent annual package registration and approval review', () => {
  const tx = { compliancePackage: mocks.packages, fiscalYear: mocks.fiscal, retainedArtifact: mocks.retained }
  const prepared = { id: 'package-2', ownerId: 'tenant-a', fiscalPeriodId: 'fy', kind: 'ANNUAL_ACCOUNTS', version: 2, status: 'CREATED', createdBy: 'preparer' }
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.transaction.mockImplementation(async work => work(tx))
    mocks.packages.findFirst.mockResolvedValue(null)
    mocks.packages.findUnique.mockResolvedValue(null)
    mocks.packages.create.mockImplementation(async ({ data }) => data)
    mocks.packages.update.mockImplementation(async ({ data }) => ({ ...prepared, ...data }))
    mocks.fiscal.findFirst.mockResolvedValue({ id: 'fy', year: 2026, startsAt: new Date('2026-01-01Z'), endsAt: new Date('2026-12-31Z') })
    mocks.persist.mockResolvedValue('closing-snapshots/tenant-a/synthetic.json')
    mocks.remove.mockResolvedValue(undefined)
    mocks.source.mockResolvedValue({ annualInput: golden, sourceFingerprint: 'source-a' })
  })

  test('Given changed sources before registration commits, when an annual package is created, then registration aborts and orphaned bytes are removed', async () => {
    mocks.current.mockRejectedValue(new Error('Annual-account sources changed'))
    await expect(createDomainReportingPackage('tenant-a', 'preparer', 'ANNUAL_ACCOUNTS', { fiscalPeriodId: 'fy', reason: 'Review regression' })).rejects.toThrow(/sources changed/)
    expect(mocks.current).toHaveBeenCalledWith(tx, expect.objectContaining({ version: 1 }))
    expect(mocks.retained.create).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
    expect(mocks.remove).toHaveBeenCalledWith('closing-snapshots/tenant-a/synthetic.json')
  })

  test('Given an independently reviewed current successor, when approved, then older approvals are superseded in the same transaction', async () => {
    mocks.packages.findFirst.mockResolvedValueOnce(prepared)
    await expect(approveReportingPackage('tenant-a', 'reviewer', prepared.id, 'Reviewed')).resolves.toMatchObject({ status: 'APPROVED' })
    expect(mocks.bytes).toHaveBeenCalledWith(tx, prepared)
    expect(mocks.current).toHaveBeenCalledWith(tx, prepared)
    expect(mocks.packages.updateMany).toHaveBeenCalledWith({ where: { ownerId: 'tenant-a', kind: 'ANNUAL_ACCOUNTS', fiscalPeriodId: 'fy', status: 'APPROVED', version: { lt: 2 } }, data: { status: 'SUPERSEDED' } })
  })

  test.each(['source', 'bytes', 'newer approval'])('Given a package with invalid %s, when approval is attempted, then no approval or supersession is written', async failure => {
    mocks.packages.findFirst.mockResolvedValueOnce(prepared)
    if (failure === 'source') mocks.current.mockRejectedValue(new Error('sources changed'))
    if (failure === 'bytes') mocks.bytes.mockRejectedValue(new Error('fixity failed'))
    if (failure === 'newer approval') mocks.packages.findFirst.mockResolvedValueOnce({ id: 'package-3', version: 3 })
    await expect(approveReportingPackage('tenant-a', 'reviewer', prepared.id, 'Reviewed')).rejects.toThrow()
    expect(mocks.packages.updateMany).not.toHaveBeenCalled()
    expect(mocks.packages.update).not.toHaveBeenCalled()
    expect(mocks.audit).not.toHaveBeenCalled()
  })
})
