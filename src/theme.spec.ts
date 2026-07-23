import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('Bootstrap theme integration', () => {
  it('configures the accounting palette before compiling Bootstrap Sass', () => {
    const theme = source('src/theme.scss')
    const bootstrapImport = theme.indexOf('@import "../node_modules/bootstrap/scss/bootstrap"')

    expect(bootstrapImport).toBeGreaterThan(0)
    expect(theme.indexOf('$primary: #185f44;')).toBeLessThan(bootstrapImport)
    expect(theme.indexOf('$body-color: #17231d;')).toBeLessThan(bootstrapImport)
    expect(theme.indexOf('$body-bg: #f5f7f4;')).toBeLessThan(bootstrapImport)
  })

  it('loads the Sass theme instead of Bootstrap precompiled CSS', () => {
    const layout = source('src/app/layout.tsx')

    expect(layout).toContain("import '../theme.scss'")
    expect(layout).not.toContain('bootstrap/dist/css/bootstrap.css')
  })

  it('keeps the header-to-content spacing at one rem on every page', () => {
    const styles = source('src/index.css')
    const workspaces = [
      'src/AccountingWorkspace.tsx',
      'src/AnnualCloseWorkspace.tsx',
      'src/ComplianceWorkspace.tsx',
      'src/EBalanceWorkspace.tsx',
      'src/ExportImportWorkspace.tsx',
      'src/TaxWorkspace.tsx',
    ].map(source).join('\n')

    expect(styles).toContain('.app-shell { max-width: 1540px; padding: 1rem clamp(16px, 3vw, 48px) 0;')
    expect(styles).toContain('.app-shell--full-width { max-width: none; padding: 1rem 16px 0; }')
    expect(styles).toContain('.workspace-toolbar { display: flex; justify-content: flex-end; }')
    expect(styles).toContain('padding: 0 0 4px;')
    expect(workspaces).not.toContain('workspace py-4')
    expect(workspaces).not.toContain('} py-4`')
  })

  it('keeps the shared footer at the viewport bottom when page content is short', () => {
    const layout = source('src/app/layout.tsx')
    const styles = source('src/index.css')

    expect(layout).toContain('<div className="page-content">{children}</div>')
    expect(layout).toContain('<footer className="app-footer mt-5 border-top pt-2 text-end">')
    expect(styles).toContain('body { min-height: 100vh; display: flex; flex-direction: column; }')
    expect(styles).toContain('.app-shell>.row>.col { display: flex; flex-direction: column; }')
    expect(styles).toContain('.page-content { flex: 1; }')
  })

  it('uses Bootstrap components for shared UI primitives', () => {
    const workspace = source('src/AccountingWorkspace.tsx')
    const accountSelector = source('src/AccountSelector.tsx')

    expect(workspace).toContain('className="btn btn-primary"')
    expect(workspace).toContain('className="alert alert-danger"')
    expect(workspace).toContain('className="card panel booking-panel"')
    expect(workspace).toContain('className="form-control"')
    expect(workspace).toContain('<AccountSelector')
    expect(accountSelector).toContain('className="form-select account-selector-trigger"')
  })

  it('keeps the posting-line remove button inside a narrow booking panel', () => {
    const styles = source('src/index.css')

    expect(styles).toContain(
      '.posting-head,.posting-line { display: grid; grid-template-columns: minmax(0,1fr) 135px 135px 36px;',
    )
    expect(styles).not.toContain('grid-template-columns: minmax(220px,1fr) 135px 135px 36px')
  })
})
