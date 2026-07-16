import 'server-only'

import { resolveAuthMode, type AuthMode } from '@/authenticationPolicy'

export type { AuthMode } from '@/authenticationPolicy'

export function getAuthMode(): AuthMode {
  return resolveAuthMode(process.env.AUTH_MODE)
}

export function isCredentialAuthEnabled(): boolean {
  return getAuthMode() === 'credentials'
}

export function isSignUpEnabled(): boolean {
  return isCredentialAuthEnabled() && process.env.BETTER_AUTH_DISABLE_SIGN_UP !== 'true'
}
