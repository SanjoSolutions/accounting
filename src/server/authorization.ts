import type { CurrentUser } from '@/authenticationPolicy'

export type AccountingPermission = 'read' | 'write' | 'manage_access'

export function hasAccountingPermission(user: CurrentUser, permission: AccountingPermission) {
  if (permission === 'read') return true
  if (permission === 'write') return user.role === 'ADMIN' || user.role === 'ACCOUNTANT'
  return user.role === 'ADMIN'
}

export function forbiddenUnless(user: CurrentUser, permission: AccountingPermission): Response | null {
  return hasAccountingPermission(user, permission)
    ? null
    : Response.json({ success: false, error: 'Your role does not permit this operation.' }, { status: 403 })
}
