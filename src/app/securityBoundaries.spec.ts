import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

function filesBelow(root: string, fileName: string): string[] {
  return readdirSync(root).flatMap(name => {
    const path = join(root, name)
    return statSync(path).isDirectory() ? filesBelow(path, fileName) : name === fileName ? [path] : []
  })
}

describe('application authentication boundaries', () => {
  it('keeps every non-auth API handler behind the current-user boundary and an explicit 401 response', () => {
    const apiRoot = resolve(process.cwd(), 'src/app/api')
    const routes = filesBelow(apiRoot, 'route.ts').filter(path => relative(apiRoot, path).replaceAll('\\', '/') !== 'auth/[...all]/route.ts')
    expect(routes.length).toBeGreaterThan(40)
    for (const route of routes) {
      const source = readFileSync(route, 'utf8')
      if (!/export\s+(?:async\s+function|const)\s+(?:GET|POST|PUT|PATCH|DELETE)\b/.test(source)) continue
      expect(source, relative(process.cwd(), route)).toMatch(/getCurrentUser\s*\(/)
      expect(source, relative(process.cwd(), route)).toMatch(/if\s*\(\s*!user\s*\)/)
      expect(source, relative(process.cwd(), route)).toMatch(/status:\s*401/)
    }
  })

  it('protects every non-public page while preserving sign-in, sign-up and the annual-close redirect', () => {
    const appRoot = resolve(process.cwd(), 'src/app')
    const publicPages = new Set(['sign-in/page.tsx', 'sign-up/page.tsx', 'annual-close/page.tsx'])
    const pages = filesBelow(appRoot, 'page.tsx')
    for (const page of pages) {
      const name = relative(appRoot, page).replaceAll('\\', '/')
      if (publicPages.has(name)) continue
      expect(readFileSync(page, 'utf8'), name).toMatch(/requirePageUser\s*\(/)
    }
  })
})
