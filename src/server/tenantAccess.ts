import 'server-only'

import { prisma } from './persistence/client'
import { appendAuditEvent } from './compliance/auditPersistence'
import type { CurrentUser } from './authentication'

export type AccountingRole = 'ADMIN' | 'ACCOUNTANT' | 'READ_ONLY'

export class TenantAccessError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export async function listTenantAccess(user: CurrentUser) {
  const [memberships, ownUser] = await Promise.all([
    prisma.tenantMembership.findMany({
      where: { ownerId: user.id },
      include: { user: { select: { email: true, name: true } } },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.user.findUnique({ where: { id: user.id }, select: { email: true, name: true } }),
  ])
  return {
    activeTenantId: user.id,
    actorId: user.actorId,
    role: user.role,
    members: [
      ...(ownUser ? [{ userId: user.id, email: ownUser.email, name: ownUser.name, role: 'ADMIN' as const, owner: true }] : []),
      ...memberships.map(item => ({ userId: item.userId, email: item.user.email, name: item.user.name, role: item.role as AccountingRole, owner: false })),
    ],
  }
}

export async function listAvailableTenants(actorId: string) {
  const memberships = await prisma.tenantMembership.findMany({ where: { userId: actorId }, select: { ownerId: true, role: true } })
  return [{ ownerId: actorId, role: 'ADMIN' as AccountingRole }, ...memberships.map(item => ({ ownerId: item.ownerId, role: item.role as AccountingRole }))]
}

export async function setTenantMember(ownerId: string, actorId: string, email: unknown, role: unknown, reason: unknown) {
  const normalizedEmail = required(email, 'email').toLowerCase()
  const normalizedReason = required(reason, 'reason')
  if (!isRole(role)) throw new TenantAccessError('role must be ADMIN, ACCOUNTANT, or READ_ONLY')
  const target = await prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true, email: true, name: true } })
  if (!target) throw new TenantAccessError('No registered user has that email address', 404)
  if (target.id === ownerId) throw new TenantAccessError('The tenant owner is always an administrator')

  return prisma.$transaction(async transaction => {
    const before = await transaction.tenantMembership.findUnique({ where: { ownerId_userId: { ownerId, userId: target.id } } })
    const membership = await transaction.tenantMembership.upsert({
      where: { ownerId_userId: { ownerId, userId: target.id } },
      create: { ownerId, userId: target.id, role },
      update: { role },
    })
    await appendAuditEvent(transaction, {
      ownerId, actorId, action: before ? 'TENANT_ROLE_CHANGED' : 'TENANT_MEMBER_ADDED', reason: normalizedReason,
      objectType: 'TenantMembership', objectId: target.id,
      before: before ? { userId: before.userId, role: before.role } : undefined,
      after: { userId: target.id, role },
    })
    return { userId: target.id, email: target.email, name: target.name, role }
  })
}

export async function removeTenantMember(ownerId: string, actorId: string, userId: unknown, reason: unknown) {
  const targetId = required(userId, 'userId')
  const normalizedReason = required(reason, 'reason')
  if (targetId === ownerId) throw new TenantAccessError('The tenant owner cannot be removed')
  return prisma.$transaction(async transaction => {
    const before = await transaction.tenantMembership.findUnique({ where: { ownerId_userId: { ownerId, userId: targetId } } })
    if (!before) throw new TenantAccessError('Tenant member not found', 404)
    await transaction.tenantMembership.delete({ where: { ownerId_userId: { ownerId, userId: targetId } } })
    await appendAuditEvent(transaction, {
      ownerId, actorId, action: 'TENANT_MEMBER_REMOVED', reason: normalizedReason,
      objectType: 'TenantMembership', objectId: targetId, before: { userId: targetId, role: before.role },
    })
    return { userId: targetId }
  })
}

function required(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) throw new TenantAccessError(`${label} is required`)
  return value.trim()
}

function isRole(value: unknown): value is AccountingRole {
  return value === 'ADMIN' || value === 'ACCOUNTANT' || value === 'READ_ONLY'
}
