import { describe, expect, it } from 'vitest'
import { appShellClassName } from './AppShell'

describe('appShellClassName', () => {
  it('uses the full-width app shell on the bookings route', () => {
    expect(appShellClassName('/bookings')).toBe('container-fluid app-shell app-shell--full-width')
  })

  it('keeps the default app shell on other routes', () => {
    expect(appShellClassName('/journal')).toBe('container-fluid app-shell')
  })
})
