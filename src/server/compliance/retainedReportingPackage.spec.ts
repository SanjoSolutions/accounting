import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { CompliancePackage, Prisma } from '@/generated/prisma/client'
import { canonicalJson } from '@/core/compliance/auditExport'
import { sha256 } from './retention'

const mocks = vi.hoisted(() => ({ read: vi.fn(), findFirst: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/storage', () => ({ getDocumentStorage: () => ({ read: mocks.read }) }))
vi.mock('./runtime', () => ({ ComplianceRuntimeError: class extends Error {} }))
import { readRetainedReportingPackage, reportingPackageChecksum } from './retainedReportingPackage'

const client = { retainedArtifact: { findFirst: mocks.findFirst } } as unknown as Prisma.TransactionClient
const payload = canonicalJson({ tenantId: 'tenant-a', amountCents: 123 })
const record = { id: 'package-a', ownerId: 'tenant-a', kind: 'ANNUAL_ACCOUNTS', fiscalPeriodId: 'fy-a', version: 2, payload, authorityRef: null, storageKey: 'closing-snapshots/tenant-a/package-a.json' } as CompliancePackage
record.checksum = reportingPackageChecksum(record)

describe('selected retained reporting package integrity', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.read.mockResolvedValue(Buffer.from(payload))
    mocks.findFirst.mockResolvedValue({ storageKey: record.storageKey, contentHash: sha256(payload) })
  })

  test('Given an exact selected version, when bytes are read, then retention is tenant-scoped and matches the database payload', async () => {
    const result = await readRetainedReportingPackage(client, record)
    expect(result.content.toString()).toBe(payload)
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { ownerId: 'tenant-a', objectType: 'CompliancePackage', objectId: 'package-a', version: 2, disposedAt: null, storageDeletedAt: null } })
  })

  test.each(['payload', 'kind', 'fiscalPeriodId', 'authorityRef'] as const)('Given tampered %s metadata, when retained bytes are checked, then the original checksum blocks it', async field => {
    await expect(readRetainedReportingPackage(client, { ...record, [field]: 'tampered' })).rejects.toThrow(/checksum/)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  test('Given substituted bytes and a matching substituted retention hash, when the package is read, then the selected payload still prevents substitution', async () => {
    mocks.read.mockResolvedValue(Buffer.from('different but correctly hashed object'))
    mocks.findFirst.mockResolvedValue({ storageKey: record.storageKey, contentHash: sha256('different but correctly hashed object') })
    await expect(readRetainedReportingPackage(client, record)).rejects.toThrow(/exact-byte/)
  })

  test('Given a swapped storage key, when package and retention registrations disagree, then no object is read', async () => {
    mocks.findFirst.mockResolvedValue({ storageKey: 'other-tenant/object', contentHash: sha256(payload) })
    await expect(readRetainedReportingPackage(client, record)).rejects.toThrow(/registration/)
    expect(mocks.read).not.toHaveBeenCalled()
  })

  test.each([null, { storageKey: record.storageKey, contentHash: '0'.repeat(64) }])('Given a missing or invalid retention registration %j, when bytes are requested, then the package fails closed', async artifact => {
    mocks.findFirst.mockResolvedValue(artifact)
    await expect(readRetainedReportingPackage(client, record)).rejects.toThrow()
  })
})
