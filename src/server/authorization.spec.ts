import { describe, expect, it } from 'vitest'
import { forbiddenUnless, hasAccountingPermission } from './authorization'
import type { CurrentUser } from '@/authenticationPolicy'
import { authenticate } from '@/authenticationPolicy'

const user = (role: CurrentUser['role']): CurrentUser => ({ id: 'tenant-a', actorId: 'user-a', name: 'User', email: 'u@example.test', role })

describe('accounting role authorization', () => {
  it('Given any tenant member, when company data is read, then access is allowed', () => {
    for (const role of ['ADMIN', 'ACCOUNTANT', 'READ_ONLY'] as const) expect(hasAccountingPermission(user(role), 'read')).toBe(true)
  })

  it('Given an accountant, when operational accounting is changed, then write access is allowed without role administration', () => {
    expect(hasAccountingPermission(user('ACCOUNTANT'), 'write')).toBe(true)
    expect(hasAccountingPermission(user('ACCOUNTANT'), 'manage_access')).toBe(false)
  })

  it('Given a read-only member, when a mutation is attempted, then a 403 response is returned', async () => {
    const response = forbiddenUnless(user('READ_ONLY'), 'write')
    expect(response?.status).toBe(403)
    await expect(response?.json()).resolves.toMatchObject({ success: false, error: expect.stringMatching(/role/) })
  })

  it('Given a malformed or future role value, when write access is checked, then authorization fails closed', () => {
    expect(hasAccountingPermission({ ...user('READ_ONLY'), role: 'UNKNOWN' as CurrentUser['role'] }, 'write')).toBe(false)
    expect(hasAccountingPermission({ ...user('READ_ONLY'), role: undefined as unknown as CurrentUser['role'] }, 'write')).toBe(false)
  })

  it('Given loopback-only no-auth mode, when the implicit solo principal reaches accounting boundaries, then it retains administrator and access-management capability without setup', async () => {
    const local = await authenticate('none', async () => null)
    expect(local).toMatchObject({ id: 'local', actorId: 'local', role: 'ADMIN' })
    expect(hasAccountingPermission(local!, 'write')).toBe(true); expect(hasAccountingPermission(local!, 'manage_access')).toBe(true)
  })
})
