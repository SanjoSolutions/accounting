'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

const fullWidthAppShellRoutes = new Set(['/bookings', '/booking-batches'])

export function appShellClassName(pathname: string) {
  return `container-fluid app-shell${fullWidthAppShellRoutes.has(pathname) ? ' app-shell--full-width' : ''}`
}

export function AppShell({ children }: { children: ReactNode }) {
  return <main className={appShellClassName(usePathname())}>{children}</main>
}
