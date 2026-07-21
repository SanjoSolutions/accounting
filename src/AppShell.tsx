'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

export function appShellClassName(pathname: string) {
  return `container-fluid app-shell${pathname === '/bookings' ? ' app-shell--full-width' : ''}`
}

export function AppShell({ children }: { children: ReactNode }) {
  return <main className={appShellClassName(usePathname())}>{children}</main>
}
