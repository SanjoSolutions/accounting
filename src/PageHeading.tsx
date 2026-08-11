import type { ReactNode } from 'react'

/**
 * Shared top-level heading treatment.
 *
 * A page title is already the clearest description of the current workspace,
 * so this component intentionally renders one semantic heading without an
 * extra category line above it. Optional trailing content is reserved for
 * page-level actions or state indicators.
 */
export function PageHeading({
  title,
  subtitle,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  children?: ReactNode
}) {
  return <header className="page-heading">
    <div>
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
    {children}
  </header>
}
