import { describe, expect, it } from 'vitest'
import { secureServiceEndpoint } from './transport'

describe('tax service transport policy', () => {
  it('requires HTTPS for remote credential-bearing tax endpoints', () => {
    expect(secureServiceEndpoint('https://authority.example/api/', 'gateway', false)).toBe('https://authority.example/api')
    expect(() => secureServiceEndpoint('http://authority.example/api', 'gateway', false)).toThrow(/must use HTTPS/)
  })
  it('permits plain HTTP only for an explicit development loopback exception', () => {
    expect(secureServiceEndpoint('http://127.0.0.1:4000', 'gateway', true)).toBe('http://127.0.0.1:4000')
    expect(() => secureServiceEndpoint('http://127.0.0.1:4000', 'gateway', false)).toThrow(/must use HTTPS/)
  })
})
