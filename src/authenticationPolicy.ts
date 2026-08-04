export type AuthMode = 'none' | 'credentials'

export interface CurrentUser {
  id: string
  actorId: string
  name: string
  email: string | null
  role: 'ADMIN' | 'ACCOUNTANT' | 'READ_ONLY'
}

export interface SessionUser {
  id: string
  name: string
  email: string
}

export function resolveAuthMode(
  value: string | undefined,
  runtimeEnvironment = process.env.NODE_ENV,
  bindingHost = process.env.APP_BIND_HOST,
): AuthMode {
  const mode = value ?? 'credentials'

  if (mode !== 'none' && mode !== 'credentials') {
    throw new Error(`Unsupported AUTH_MODE: ${mode}`)
  }
  if (runtimeEnvironment !== 'test' && mode === 'none' && !isLoopbackHost(bindingHost)) {
    throw new Error('AUTH_MODE=none requires APP_BIND_HOST to be an explicit loopback address')
  }

  return mode
}

export function isLoopbackHost(value: string | undefined) {
  if (!value) return false
  const candidate = value.trim().toLowerCase()
  const bracketed = candidate.startsWith('[') || candidate.endsWith(']')
  if (bracketed && !(candidate.startsWith('[') && candidate.endsWith(']'))) return false
  const host = bracketed ? candidate.slice(1, -1) : candidate
  if (bracketed && !host.includes(':')) return false
  if (host === 'localhost' || host === '::1' || /^(?:0{1,4}:){7}0{0,3}1$/.test(host)) return true
  const octets = host.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^(?:0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
}

export async function authenticate(
  mode: AuthMode,
  getSessionUser: () => Promise<SessionUser | null>,
): Promise<CurrentUser | null> {
  if (mode === 'none') {
    return { id: 'local', actorId: 'local', name: 'Local user', email: null, role: 'ADMIN' }
  }

  const user = await getSessionUser()
  return user ? { ...user, actorId: user.id, role: 'ADMIN' } : null
}
