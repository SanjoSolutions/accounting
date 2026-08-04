import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const directory = mkdtempSync(join(tmpdir(), 'accounting-tenant-access-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let access: typeof import('./tenantAccess')
let prisma: typeof import('./persistence/client').prisma

beforeAll(async () => {
  const database = new DatabaseSync(databasePath)
  const migrations = resolve(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  database.close()
  process.env.DATABASE_URL = `file:${databasePath}`
  access = await import('./tenantAccess')
  prisma = (await import('./persistence/client')).prisma
  await prisma.user.createMany({ data: [
    { id: 'owner-a', name: 'Owner A', email: 'owner@example.test', emailVerified: true },
    { id: 'reader-a', name: 'Reader A', email: 'reader@example.test', emailVerified: true },
    { id: 'outsider-b', name: 'Outsider B', email: 'outsider@example.test', emailVerified: true },
  ] })
})

afterAll(async () => { await prisma.$disconnect(); rmSync(directory, { recursive: true, force: true }) })

describe('tenant membership persistence', () => {
  it('Given a registered user, when an owner grants and changes a role, then one tenant-scoped membership and chained audit history persist', async () => {
    await access.setTenantMember('owner-a', 'owner-a', 'reader@example.test', 'READ_ONLY', 'External adviser review')
    await access.setTenantMember('owner-a', 'owner-a', 'reader@example.test', 'ACCOUNTANT', 'Bookkeeping engagement approved')

    await expect(prisma.tenantMembership.findUnique({ where: { ownerId_userId: { ownerId: 'owner-a', userId: 'reader-a' } } })).resolves.toMatchObject({ role: 'ACCOUNTANT' })
    await expect(prisma.auditEvent.findMany({ where: { ownerId: 'owner-a', objectId: 'reader-a' }, orderBy: { occurredAt: 'asc' }, select: { action: true, actorId: true } })).resolves.toEqual([
      { action: 'TENANT_MEMBER_ADDED', actorId: 'owner-a' },
      { action: 'TENANT_ROLE_CHANGED', actorId: 'owner-a' },
    ])
  })

  it('Given memberships in one company, when available tenants are listed, then another user receives only their own and explicitly assigned companies', async () => {
    const tenants = await access.listAvailableTenants('reader-a')
    expect(tenants).toEqual(expect.arrayContaining([{ ownerId: 'reader-a', role: 'ADMIN' }, { ownerId: 'owner-a', role: 'ACCOUNTANT' }]))
    expect(tenants).not.toEqual(expect.arrayContaining([{ ownerId: 'outsider-b', role: expect.anything() }]))
  })

  it('Given an assigned member, when access is revoked, then membership removal is atomic and auditable', async () => {
    await access.removeTenantMember('owner-a', 'owner-a', 'reader-a', 'Engagement ended')
    await expect(prisma.tenantMembership.findUnique({ where: { ownerId_userId: { ownerId: 'owner-a', userId: 'reader-a' } } })).resolves.toBeNull()
    await expect(prisma.auditEvent.findFirst({ where: { ownerId: 'owner-a', objectId: 'reader-a', action: 'TENANT_MEMBER_REMOVED' } })).resolves.toMatchObject({ actorId: 'owner-a' })
  })

  it('Given the company owner, when removal or demotion is attempted, then permanent owner administration fails closed', async () => {
    await expect(access.setTenantMember('owner-a', 'owner-a', 'owner@example.test', 'READ_ONLY', 'invalid')).rejects.toThrow(/always an administrator/)
    await expect(access.removeTenantMember('owner-a', 'owner-a', 'owner-a', 'invalid')).rejects.toThrow(/cannot be removed/)
  })
})
