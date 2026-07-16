export type AuthMode = 'none' | 'credentials'

export interface CurrentUser {
  id: string
  name: string
  email: string | null
}

export interface SessionUser {
  id: string
  name: string
  email: string
}

export function resolveAuthMode(value: string | undefined): AuthMode {
  const mode = value ?? 'none'

  if (mode !== 'none' && mode !== 'credentials') {
    throw new Error(`Unsupported AUTH_MODE: ${mode}`)
  }

  return mode
}

export async function authenticate(
  mode: AuthMode,
  getSessionUser: () => Promise<SessionUser | null>,
): Promise<CurrentUser | null> {
  if (mode === 'none') {
    return { id: 'local', name: 'Local user', email: null }
  }

  return getSessionUser()
}
