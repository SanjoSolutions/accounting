import { describe, expect, test } from 'vitest'
import { appShellClassName } from './AppShell'

describe('appShellClassName', () => {
  test('uses the full-width app shell for booking entry and batch review routes', () => {
    expect(appShellClassName('/bookings')).toBe('container-fluid app-shell app-shell--full-width')
    expect(appShellClassName('/booking-batches')).toBe('container-fluid app-shell app-shell--full-width')
  })

  test('keeps the default app shell on other routes', () => {
    expect(appShellClassName('/journal')).toBe('container-fluid app-shell')
  })
})
