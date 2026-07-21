"use client"

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'
import type { AuthMode, CurrentUser } from './authenticationPolicy'
import { authClient } from './auth-client'
import { defaultFiscalYear } from './FiscalYearNavigation'

export const exportImportHref = '/export-import'
export const complianceHref = '/compliance'
export const bookingHref = '/bookings'
export const journalHref = '/journal'
export const accountingNavigation = [
  { href: bookingHref, label: 'Bookings' },
  { href: journalHref, label: 'Journal' },
] as const

export function Navbar({
  authMode,
  signUpEnabled,
  user,
}: {
  authMode: AuthMode
  signUpEnabled: boolean
  user: CurrentUser | null
}): any {
  const t = useTranslations('Navbar')
  const pathname = usePathname()
  const router = useRouter()
  const [signOutError, setSignOutError] = useState<string | null>(null)

  const navClassName = (href: string) =>
    `nav-link${pathname === href || pathname.startsWith(`${href}/`) ? ' active' : ''}`
  const year = new Date().getFullYear()
  const annualCloseYear = defaultFiscalYear('annual-close', year)
  const eBalanceYear = defaultFiscalYear('e-bilanz', year)
  const taxYear = defaultFiscalYear('tax', year)

  return (
    <nav className="navbar navbar-expand-lg navbar-light bg-light">
      <div className="container-fluid">
        <Link href="/" className="navbar-brand">{ t('Accounting') }</Link>
        <button
          className="navbar-toggler"
          type="button"
          data-bs-toggle="collapse"
          data-bs-target="#navbarSupportedContent"
          aria-controls="navbarSupportedContent"
          aria-expanded="false"
          aria-label="Toggle navigation"
        >
          <span className="navbar-toggler-icon" />
        </button>
        <div className="collapse navbar-collapse" id="navbarSupportedContent">
          {user && <ul className="navbar-nav me-auto mb-2 mb-lg-0">
            {accountingNavigation.map(item => <li className="nav-item" key={item.href}>
              <Link href={item.href} className={navClassName(item.href)}>{t(item.label)}</Link>
            </li>)}
            <li className="nav-item">
              <Link
                href={`/annual-close/${annualCloseYear}`}
                className={navClassName('/annual-close')}
              >{ t('Annual close') }</Link>
            </li>
            <li className="nav-item">
              <Link href={`/e-bilanz/${eBalanceYear}`} className={navClassName('/e-bilanz')}>{ t('E-balance') }</Link>
            </li>
            <li className="nav-item">
              <Link href={`/tax/${taxYear}`} className={navClassName('/tax')}>{ t('Tax filings') }</Link>
            </li>
            <li className="nav-item">
              <Link href={exportImportHref} className={navClassName(exportImportHref)}>{ t('ExportImport') }</Link>
            </li>
            <li className="nav-item">
              <Link href={complianceHref} className={navClassName(complianceHref)}>{ t('Compliance') }</Link>
            </li>
            <li className="nav-item">
              <Link href="/settings" className={navClassName('/settings')}>{ t('Settings') }</Link>
            </li>
          </ul>}
          {authMode === 'credentials' && (
            user ? (
              <div className="d-flex align-items-center gap-3">
                <span className="navbar-text">{user.email}</span>
                <button
                  type="button"
                  className="btn btn-outline-secondary"
                  onClick={async () => {
                    setSignOutError(null)
                    const result = await authClient.signOut()
                    if (result.error) {
                      setSignOutError(result.error.message ?? 'Sign out failed.')
                      return
                    }
                    router.push('/sign-in')
                    router.refresh()
                  }}
                >Sign out</button>
                {signOutError && <span className="text-danger" role="alert">{signOutError}</span>}
              </div>
            ) : (
              <div className="d-flex gap-2">
                <Link className="btn btn-outline-primary" href="/sign-in">Sign in</Link>
                {signUpEnabled && <Link className="btn btn-primary" href="/sign-up">Create account</Link>}
              </div>
            )
          )}
        </div>
      </div>
    </nav>
  )
}
