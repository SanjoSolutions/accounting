"use client"

import { useTranslations } from 'next-intl'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

export function Navbar(): any {
  const t = useTranslations('Navbar')
  const pathname = usePathname()

  const navClassName = (href: string) =>
    `nav-link${pathname === href ? ' active' : ''}`

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
          <ul className="navbar-nav me-auto mb-2 mb-lg-0">
            <li className="nav-item">
              <Link href="/" className={navClassName('/')}>{ t('Create booking record') }</Link>
            </li>
            <li className="nav-item">
              <Link
                href="/balance-sheets/create"
                className={navClassName('/balance-sheets/create')}
              >{ t('Create balance sheet') }</Link>
            </li>
            <li className="nav-item">
              <Link href="/settings" className={navClassName('/settings')}>{ t('Settings') }</Link>
            </li>
          </ul>
        </div>
      </div>
    </nav>
  )
}
