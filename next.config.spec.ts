import { describe, expect, it } from 'vitest'
import { contentSecurityPolicy, nextConfig, securityHeaders } from './next.config'

describe('HTTP security policy', () => {
  it('applies restrictive browser headers to every application route without breaking loopback HTTP', async () => {
    await expect(nextConfig.headers?.()).resolves.toEqual([{ source: '/:path*', headers: securityHeaders }])
    expect(Object.fromEntries(securityHeaders.map(header => [header.key, header.value]))).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
      'Cross-Origin-Opener-Policy': 'same-origin',
    })
    expect(securityHeaders.map(header => header.key)).not.toContain('Strict-Transport-Security')
  })

  it('blocks embedding, plugins, cross-origin forms and wildcard network access', () => {
    for (const directive of ["base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "connect-src 'self'"]) expect(contentSecurityPolicy).toContain(directive)
    expect(contentSecurityPolicy).not.toMatch(/(?:^|\s)\*(?:\s|;|$)/)
    expect(contentSecurityPolicy).not.toContain("'unsafe-eval'")
  })
})
