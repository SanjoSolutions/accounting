import { describe, expect, it } from 'vitest'
import { nextConfig } from '../next.config'

describe('Next.js development origins', () => {
  it('allows the loopback address used to test the local app', () => {
    expect(nextConfig.allowedDevOrigins).toContain('127.0.0.1')
  })
})
