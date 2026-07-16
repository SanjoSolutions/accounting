import { describe, expect, it, vi } from 'vitest'
import { authenticate, resolveAuthMode } from './authenticationPolicy'

describe('resolveAuthMode', () => {
  it('defaults to local no-auth mode', () => {
    expect(resolveAuthMode(undefined)).toBe('none')
  })

  it('supports credential authentication as an opt-in', () => {
    expect(resolveAuthMode('credentials')).toBe('credentials')
  })

  it('rejects unknown modes instead of silently disabling authentication', () => {
    expect(() => resolveAuthMode('credential')).toThrow('Unsupported AUTH_MODE')
  })
})

describe('authenticate', () => {
  it('returns the local principal without consulting a session', async () => {
    const getSessionUser = vi.fn(async () => null)

    await expect(authenticate('none', getSessionUser)).resolves.toEqual({
      id: 'local',
      name: 'Local user',
      email: null,
    })
    expect(getSessionUser).not.toHaveBeenCalled()
  })

  it('requires a valid session in credential mode', async () => {
    await expect(authenticate('credentials', async () => null)).resolves.toBeNull()

    const user = { id: 'user-1', name: 'Ada', email: 'ada@example.com' }
    await expect(authenticate('credentials', async () => user)).resolves.toEqual(user)
  })
})
