"use client"

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import type { AuthMode, CurrentUser } from './authenticationPolicy'
import { authClient } from './auth-client'
import { defaultFiscalYear, fiscalYearContextFromPath, FiscalYearNavigation } from './FiscalYearNavigation'

export const exportImportHref = '/export-import'
export const complianceHref = '/compliance'
export const reportsHref = '/reports'
export const bookingHref = '/bookings'
export const bookingBatchesHref = '/booking-batches'
export const journalHref = '/journal'
export const receivablesHref = '/receivables'
export const invoicesHref = '/invoices'
export const bankingHref = '/banking'
export const fixedAssetsHref = '/fixed-assets'

type NavigationItem = { href: string; label: string; activePath?: string }

/** The small set of destinations that stays visible in the primary navbar. */
export const primaryNavigation = [
  { href: bookingHref, label: 'Bookings' },
  { href: bookingBatchesHref, label: 'Booking batches' },
  { href: journalHref, label: 'Journal' },
] as const

/** Static destinations grouped beneath the translated Andere/Other menu. */
export const otherNavigation = [
  { href: receivablesHref, label: 'Receivables' },
  { href: invoicesHref, label: 'Invoices' },
  { href: bankingHref, label: 'Banking' },
  { href: fixedAssetsHref, label: 'Fixed assets' },
  { href: exportImportHref, label: 'ExportImport' },
  { href: complianceHref, label: 'Compliance' },
  { href: '/settings', label: 'Settings' },
] as const

/**
 * Keep the old export as a compatibility alias for callers that used the
 * accounting-only navigation list. New code should use primaryNavigation.
 */
export const accountingNavigation = primaryNavigation

export function otherNavigationItems(currentYear: number): NavigationItem[] {
  const operational = otherNavigation.slice(0, 4)
  const utility = otherNavigation.slice(4)
  return [
    ...operational,
    { href: `/annual-close/${defaultFiscalYear('annual-close', currentYear)}`, activePath: '/annual-close', label: 'Annual close' },
    { href: `/e-bilanz/${defaultFiscalYear('e-bilanz', currentYear)}`, activePath: '/e-bilanz', label: 'E-balance' },
    { href: `/tax/${defaultFiscalYear('tax', currentYear)}`, activePath: '/tax', label: 'Tax filings' },
    { href: `${reportsHref}/${defaultFiscalYear('reports', currentYear)}`, activePath: reportsHref, label: 'Reports' },
    ...utility,
  ]
}

export function navigationItemIsActive(pathname: string, item: Pick<NavigationItem, 'href' | 'activePath'>) {
  const activePath = item.activePath ?? item.href
  return pathname === activePath || pathname.startsWith(`${activePath}/`)
}

export function primaryNavigationHref(href: string, year: number) {
  return href === bookingHref || href === bookingBatchesHref || href === journalHref
    ? `${href}?year=${year}`
    : href
}

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
  const searchParams = useSearchParams()
  const router = useRouter()
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [otherOpen, setOtherOpen] = useState(false)
  const otherToggleRef = useRef<HTMLButtonElement>(null)
  const otherMenuRef = useRef<HTMLUListElement>(null)

  const searchQuery = searchParams.toString()
  useEffect(() => {
    setMenuOpen(false)
    setOtherOpen(false)
  }, [pathname, searchQuery])

  useEffect(() => {
    if (!otherOpen) return

    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node) || (!otherToggleRef.current?.contains(target) && !otherMenuRef.current?.contains(target))) setOtherOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOtherOpen(false)
      requestAnimationFrame(() => otherToggleRef.current?.focus())
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [otherOpen])

  const currentYear = new Date().getFullYear()
  const fiscalYearContext = fiscalYearContextFromPath(pathname, searchParams.get('year'))
  const navigationYear = fiscalYearContext?.year ?? currentYear
  const otherItems = otherNavigationItems(navigationYear)
  const otherActive = pathname === '/access' || otherItems.some(item => navigationItemIsActive(pathname, item))
  const navClassName = (href: string) => `nav-link${navigationItemIsActive(pathname, { href }) ? ' active' : ''}`

  return (
    <nav className="navbar navbar-expand-lg navbar-light bg-light">
      <div className="container-fluid">
        <Link href="/" className="navbar-brand">{t('Accounting')}</Link>
        <button
          className="navbar-toggler"
          type="button"
          aria-controls="navbarSupportedContent"
          aria-expanded={menuOpen}
          aria-label="Toggle navigation"
          onClick={() => setMenuOpen(open => !open)}
        >
          <span className="navbar-toggler-icon" />
        </button>
        <div className={`collapse navbar-collapse${menuOpen ? ' show' : ''}`} id="navbarSupportedContent">
          {user && <ul className="navbar-nav me-auto mb-2 mb-lg-0">
            {primaryNavigation.map(item => <li className="nav-item" key={item.href}>
              <Link href={primaryNavigationHref(item.href, navigationYear)} className={navClassName(item.href)} onClick={() => setMenuOpen(false)}>{t(item.label)}</Link>
            </li>)}
            <li className={`nav-item dropdown${otherOpen ? ' show' : ''}`}>
              <button
                ref={otherToggleRef}
                type="button"
                className={`nav-link dropdown-toggle${otherActive ? ' active' : ''}`}
                aria-expanded={otherOpen}
                aria-controls="navbar-other-menu"
                aria-haspopup="true"
                onClick={() => setOtherOpen(open => !open)}
              >{t('Other')}</button>
              <ul ref={otherMenuRef} id="navbar-other-menu" className={`dropdown-menu${otherOpen ? ' show' : ''}`} role="menu" aria-hidden={!otherOpen}>
                {otherItems.map(item => <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`dropdown-item${navigationItemIsActive(pathname, item) ? ' active' : ''}`}
                    role="menuitem"
                    onClick={() => { setOtherOpen(false); setMenuOpen(false) }}
                  >{t(item.label)}</Link>
                </li>)}
                {authMode === 'credentials' && <li>
                  <Link href="/access" className={`dropdown-item${navClassName('/access').includes('active') ? ' active' : ''}`} role="menuitem" onClick={() => { setOtherOpen(false); setMenuOpen(false) }}>{t('Users')}</Link>
                </li>}
              </ul>
            </li>
          </ul>}
          {user && fiscalYearContext && (
            <div className="navbar-fiscal-year">
              <FiscalYearNavigation area={fiscalYearContext.area} year={fiscalYearContext.year} />
            </div>
          )}
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
