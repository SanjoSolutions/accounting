import 'server-only'

import { randomUUID } from 'node:crypto'
import { prisma } from '@/server/persistence/client'
import { validateVersionedCompanyProfile } from './companyProfile'
import { appendAuditEvent } from './auditPersistence'
import { ComplianceRuntimeError } from './runtime'

const day = (date: Date) => date.toISOString().slice(0, 10)

export async function createHistoricalProfileForFiscalYear(ownerId: string, actorId: string, year: number, input: Record<string, unknown>, today = new Date().toISOString().slice(0, 10)) {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const evidenceId = typeof input.evidenceId === 'string' ? input.evidenceId.trim() : ''
  if (!reason || !evidenceId) throw new ComplianceRuntimeError('Historical profile reason and retained evidence are required')
  const issues = validateVersionedCompanyProfile(input.profile)
  if (issues.length) throw new ComplianceRuntimeError(`Historical company profile is invalid: ${issues.join('; ')}`)
  const period = await prisma.fiscalYear.findUnique({ where: { ownerId_year: { ownerId, year } }, select: { id: true, startsAt: true, endsAt: true } })
  if (!period) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  if (day(period.endsAt) >= today) throw new ComplianceRuntimeError('Historical profile onboarding is only available for a completed fiscal period', 409)
  const [artifact, document] = await Promise.all([
    prisma.retainedArtifact.findFirst({ where: { id: evidenceId, ownerId, disposedAt: null, storageDeletedAt: null }, select: { id: true, contentHash: true } }),
    prisma.documentRecord.findFirst({ where: { id: evidenceId, ownerId }, select: { id: true } }),
  ])
  if (!artifact && !document) throw new ComplianceRuntimeError('Historical profile evidence is missing or outside the authenticated tenant', 409)
  const payload = JSON.stringify(input.profile)
  return prisma.$transaction(async transaction => {
    await transaction.$executeRaw`UPDATE FiscalYear SET id = id WHERE id = ${period.id}`
    const overlaps = await transaction.companyProfileVersion.findMany({ where: { ownerId, effectiveFrom: { lte: period.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.startsAt } }] } })
    const exact = overlaps.find(version => version.effectiveFrom.getTime() === period.startsAt.getTime() && version.effectiveTo?.getTime() === period.endsAt.getTime() && version.payload === payload && version.createdBy === actorId && version.reason === reason)
    if (exact) return exact
    if (overlaps.length) throw new ComplianceRuntimeError('A company profile version already overlaps this fiscal period', 409)
    const version = await transaction.companyProfileVersion.create({ data: { id: randomUUID(), ownerId, effectiveFrom: period.startsAt, effectiveTo: period.endsAt, payload, createdBy: actorId, reason } })
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'HISTORICAL_PROFILE_CREATED', reason, objectType: 'CompanyProfileVersion', objectId: version.id, after: { fiscalPeriodId: period.id, effectiveFrom: day(period.startsAt), effectiveTo: day(period.endsAt), evidenceId, evidenceKind: artifact ? 'RETAINED_ARTIFACT' : 'DOCUMENT' } })
    return version
  })
}
