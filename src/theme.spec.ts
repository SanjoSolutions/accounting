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

  it('uses Bootstrap components for shared UI primitives', () => {
    const workspace = source('src/AccountingWorkspace.tsx')

    expect(workspace).toContain('className="btn btn-primary"')
    expect(workspace).toContain('className="alert alert-danger"')
    expect(workspace).toContain('className="card panel booking-panel"')
    expect(workspace).toContain('className="form-control"')
    expect(workspace).toContain('className="form-select"')
  })
})
