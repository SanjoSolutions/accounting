import { readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Prisma development startup', () => {
  it('applies committed migrations and generates the Prisma client before starting Next.js', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.dev).toBe('prisma migrate deploy && prisma generate && next dev')
  })

  it('offers one-command solo modes that force no-auth Next.js onto loopback', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const configuration = JSON.parse(execFileSync(process.execPath, [
      resolve(process.cwd(), 'tools/local-solo.mjs'),
      '--print-config',
    ], { encoding: 'utf8' })) as { environment: Record<string, string>; arguments: string[] }

    expect(packageJson.scripts?.solo).toBe('prisma migrate deploy && prisma generate && node tools/local-solo.mjs dev')
    expect(packageJson.scripts?.['dev:local-solo']).toBe('pnpm solo')
    expect(packageJson.scripts?.['start:local-solo']).toBe('node tools/local-solo.mjs start')
    expect(packageJson.scripts?.['test:e2e:local-solo']).toBe('playwright test --config playwright.local-solo.config.ts')
    expect(configuration).toEqual({
      environment: { AUTH_MODE: 'none', APP_BIND_HOST: '127.0.0.1' },
      arguments: ['dev', '--hostname', '127.0.0.1'],
      startupMessages: [
        '[local-solo] Authentication: OFF (single local user)',
        '[local-solo] Listening only on http://127.0.0.1:3000',
        '[local-solo] Database: file:./accounting.db',
        '[local-solo] Stop with Ctrl+C. Use `pnpm dev` with AUTH_MODE=credentials for authenticated deployments.',
      ],
    })
  })

  it('refuses every Next.js hostname override before starting no-auth mode', () => {
    const launcher = resolve(process.cwd(), 'tools/local-solo.mjs')
    for (const args of [['--hostname', '0.0.0.0'], ['--hostname=::'], ['-H', '192.168.1.5'], ['-H=0.0.0.0'], ['-H127.0.0.2']]) {
      const result = spawnSync(process.execPath, [launcher, 'dev', ...args], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('fixes the hostname to 127.0.0.1')
    }
  })

  it('keeps pnpm build permissions in the workspace configuration', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      pnpm?: unknown
    }
    const workspaceConfig = readFileSync(resolve(process.cwd(), 'pnpm-workspace.yaml'), 'utf8')

    expect(packageJson.pnpm).toBeUndefined()
    expect(workspaceConfig).toMatch(/allowBuilds:\s+[\s\S]*better-sqlite3: true/)
  })

  it('keeps disposable Playwright databases and their SQLite sidecars out of version control', () => {
    const gitignore = readFileSync(resolve(process.cwd(), '.gitignore'), 'utf8')

    expect(gitignore).toContain('/playwright.db-wal')
    expect(gitignore).toContain('/roles-playwright.db*')
  })

  it('keeps Prisma runtime packages aligned and forces the patched transitive URL parser', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> }
    const workspaceConfig = readFileSync(resolve(process.cwd(), 'pnpm-workspace.yaml'), 'utf8')

    expect(packageJson.dependencies['@prisma/client']).toBe('^7.9.1')
    expect(packageJson.dependencies['@prisma/adapter-better-sqlite3']).toBe('^7.9.1')
    expect(packageJson.dependencies.prisma).toBe('^7.9.1')
    expect(packageJson.devDependencies.prisma).toBeUndefined()
    expect(packageJson.dependencies.next).toBe('^16.3.0')
    expect(workspaceConfig).toMatch(/overrides:\s+[\s\S]*fast-uri: 3\.1\.5/)
  })

  it('provides enforced type, coverage, build and no-mock browser quality gates', () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/quality.yml'), 'utf8')
    expect(packageJson.scripts).toMatchObject({ typecheck: 'tsc --noEmit', 'audit:security': 'pnpm audit --audit-level high', coverage: 'vitest run --coverage --reporter html', 'coverage:ci': 'vitest run --coverage --coverage.reporter=text --coverage.reporter=json-summary', 'test:e2e': 'playwright test' })
    for (const command of ['pnpm typecheck', 'pnpm audit:security', 'pnpm coverage:ci', 'pnpm build', 'pnpm test:e2e', 'pnpm test:e2e:local-solo']) expect(workflow).toContain(command)
    expect(workflow).toContain('pnpm install --frozen-lockfile')
  })
})
