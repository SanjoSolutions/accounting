import { describe, expect, it, vi } from 'vitest'
import { authenticate, isLoopbackHost, resolveAuthMode } from './authenticationPolicy'

describe('resolveAuthMode', () => {
  it('defaults to credential authentication', () => {
    expect(resolveAuthMode(undefined, 'development')).toBe('credentials')
  })

  it('supports explicit loopback no-auth mode outside production and isolated tests', () => {
    expect(resolveAuthMode('none', 'development', '127.0.0.1')).toBe('none')
    expect(resolveAuthMode('none', 'test')).toBe('none')
  })

  it('allows production no-auth mode only for an explicit loopback binding', () => {
    expect(resolveAuthMode('none', 'production', '127.0.0.1')).toBe('none')
    expect(resolveAuthMode('none', 'production', '::1')).toBe('none')
    expect(resolveAuthMode('none', 'production', 'localhost')).toBe('none')
  })

  it('fails closed when production no-auth mode could accept network traffic', () => {
    for (const host of [undefined, '', '0.0.0.0', '::', '192.168.1.10', '127.0.0.999', 'accounting.internal']) {
      expect(() => resolveAuthMode('none', 'production', host)).toThrow('explicit loopback address')
    }
  })

  it('fails closed for unsafe no-auth bindings in development too', () => {
    for (const host of [undefined, '', '0.0.0.0', '::', '10.0.0.4', 'localhost.example']) expect(() => resolveAuthMode('none', 'development', host)).toThrow('explicit loopback address')
  })

  it('rejects unknown modes instead of silently disabling authentication', () => {
    expect(() => resolveAuthMode('credential', 'development')).toThrow('Unsupported AUTH_MODE')
  })
})

describe('isLoopbackHost', () => {
  it('accepts explicit conventional IPv4, IPv6, bracketed IPv6, and localhost loopback names', () => {
    for (const host of ['localhost', ' LOCALHOST ', '127.0.0.1', '127.255.255.255', '::1', '[::1]', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001']) expect(isLoopbackHost(host)).toBe(true)
  })

  it('rejects wildcards, interfaces, ambiguous IPv4, mapped IPv6, ports, URLs, zones, and malformed brackets', () => {
    for (const host of [undefined, '', '0.0.0.0', '::', '[::]', '[::1', '::1]', '[127.0.0.1]', '::ffff:127.0.0.1', 'fe80::1%lo0', '127.0.0.01', '127.1', '127.0.0.1:3000', 'http://127.0.0.1', 'localhost.', '192.168.1.2']) expect(isLoopbackHost(host)).toBe(false)
  })
})

describe('authenticate', () => {
  it('returns the local principal without consulting a session', async () => {
    const getSessionUser = vi.fn(async () => null)

    await expect(authenticate('none', getSessionUser)).resolves.toEqual({
      id: 'local',
      actorId: 'local',
      name: 'Local user',
      email: null,
      role: 'ADMIN',
    })
    expect(getSessionUser).not.toHaveBeenCalled()
  })

  it('requires a valid session in credential mode', async () => {
    await expect(authenticate('credentials', async () => null)).resolves.toBeNull()

    const user = { id: 'user-1', name: 'Ada', email: 'ada@example.com' }
    await expect(authenticate('credentials', async () => user)).resolves.toEqual({ ...user, actorId: user.id, role: 'ADMIN' })
  })
})
