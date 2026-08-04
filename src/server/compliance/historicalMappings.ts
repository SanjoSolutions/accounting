import 'server-only'

import { randomUUID } from 'node:crypto'
import { createHgbStatementRuleSet } from '@/core/hgbStatements'
import { prisma } from '@/server/persistence/client'
import { validateMappings, type AccountMapping } from './chartLifecycle'
import { appendAuditEvent } from './auditPersistence'
import { ComplianceRuntimeError } from './runtime'
import { complianceReferenceDate } from './referenceDate'

const day = (date: Date) => date.toISOString().slice(0, 10)

export async function createHistoricalMappingsForFiscalYear(ownerId: string, actorId: string, year: number, input: Record<string, unknown>, today = complianceReferenceDate()) {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const evidenceId = typeof input.evidenceId === 'string' ? input.evidenceId.trim() : ''
  const chartId = typeof input.chartId === 'string' ? input.chartId.trim() : ''
  const size = input.size === 'MICRO' || input.size === 'SMALL' ? input.size : undefined
  const method = input.method === 'GKV' || input.method === 'UKV' ? input.method : undefined
  const mappings = input.mappings as AccountMapping[]
  if (!reason || !evidenceId || !chartId || !size || !method || !Array.isArray(mappings) || !mappings.length) throw new ComplianceRuntimeError('Historical mapping chart, size, method, mappings, reason and retained evidence are required')
  const issues = validateMappings(mappings)
  if (new Set(mappings.map(mapping => mapping.accountNumber)).size !== mappings.length) issues.push('Account numbers must be unique within a mapping cohort')
  const ruleSet = createHgbStatementRuleSet(size, method)
  const registered = new Map(ruleSet.lines.map(line => [line.id, line] as const))
  const parents = new Set(ruleSet.lines.map(line => line.parentId).filter(Boolean))
  for (const [index, mapping] of mappings.entries()) {
    const line = registered.get(mapping.hgbPosition)
    if (!line || !line.role || parents.has(line.id)) issues.push(`${index}: HGB position must be a registered account-bearing leaf for the selected close layout`)
    if (![-1, 1].includes(mapping.presentationSign ?? 1)) issues.push(`${index}: presentationSign must be 1 or -1`)
    if (line?.role) {
      const expected = line.role === 'ASSET' || line.role === 'EXPENSE' ? 1 : -1
      const actual = (mapping.normalBalance === 'DEBIT' ? 1 : -1) * (mapping.presentationSign ?? 1)
      if (actual !== expected) issues.push(`${index}: normal balance and presentation sign are incompatible with ${line.role}`)
    }
  }
  if (issues.length) throw new ComplianceRuntimeError(`Historical mappings are invalid: ${issues.join('; ')}`)
  const period = await prisma.fiscalYear.findUnique({ where: { ownerId_year: { ownerId, year } }, select: { id: true, startsAt: true, endsAt: true } })
  if (!period) throw new ComplianceRuntimeError('Fiscal period not found', 404)
  if (day(period.endsAt) >= today) throw new ComplianceRuntimeError('Historical mapping onboarding is only available for a completed fiscal period', 409)
  const [artifact, document] = await Promise.all([
    prisma.retainedArtifact.findFirst({ where: { id: evidenceId, ownerId, disposedAt: null, storageDeletedAt: null }, select: { id: true } }),
    prisma.documentRecord.findFirst({ where: { id: evidenceId, ownerId }, select: { id: true } }),
  ])
  if (!artifact && !document) throw new ComplianceRuntimeError('Historical mapping evidence is missing or outside the authenticated tenant', 409)
  return prisma.$transaction(async transaction => {
    await transaction.$executeRaw`UPDATE FiscalYear SET id = id WHERE id = ${period.id}`
    const overlaps = await transaction.accountMappingVersion.findMany({ where: { ownerId, chartId, effectiveFrom: { lte: period.endsAt }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: period.startsAt } }] } })
    if (overlaps.length) throw new ComplianceRuntimeError('An account-mapping cohort already overlaps this fiscal period', 409)
    const rows = []
    for (const mapping of [...mappings].sort((left, right) => left.accountNumber - right.accountNumber)) rows.push(await transaction.accountMappingVersion.create({ data: { id: randomUUID(), ownerId, chartId, accountNumber: mapping.accountNumber, effectiveFrom: period.startsAt, effectiveTo: period.endsAt, accountName: mapping.name.trim(), accountType: mapping.accountType, normalBalance: mapping.normalBalance, presentationSign: mapping.presentationSign ?? 1, hgbPosition: mapping.hgbPosition.trim(), eBilanzPosition: mapping.eBilanzPosition.trim(), vatCode: mapping.vatCode?.trim() || null, active: mapping.active !== false } }))
    await appendAuditEvent(transaction, { ownerId, actorId, action: 'HISTORICAL_MAPPING_COHORT_CREATED', reason, objectType: 'AccountMappingVersion', objectId: `${chartId}:${year}`, after: { fiscalPeriodId: period.id, chartId, mappingVersionIds: rows.map(row => row.id), evidenceId } })
    return rows
  })
}
