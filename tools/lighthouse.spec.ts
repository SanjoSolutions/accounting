import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { assertPortAvailable, lighthouseEnvironment } from './lighthouse.mjs'
import configuration from './lighthouse-config.cjs'

const { createLighthouseConfig, lighthousePort } = configuration
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('isolated Lighthouse QA', () => {
  test.each(['3000', '80', '0', '65536', '-1', '', '3234/path', 'https://example.com'])('given unsafe port %s, when configuring QA, then it refuses to audit', value => {
    expect(() => lighthousePort({ LIGHTHOUSE_PORT: value })).toThrow(/other than the live app port 3000/)
  })

  test('given an unused configured port, when selecting pages, then all audits stay on its loopback origin', () => {
    const config = createLighthouseConfig({ LIGHTHOUSE_PORT: '3235' }).ci
    expect(config.collect.url.map(value => new URL(value).origin)).toEqual(Array(3).fill('http://127.0.0.1:3235'))
    expect(config.collect.url.map(value => new URL(value).pathname)).toEqual(['/', '/bookings', '/settings'])
    expect(config.collect.numberOfRuns).toBe(3)
    expect(config.collect.settings.preset).toBe('desktop')
    expect(config.upload.target).toBe('filesystem')
    expect(lighthousePort({})).toBe(3234)
  })

  test('given live environment settings, when starting QA, then build and server use only the disposable database and storage', () => {
    const cwd = process.cwd()
    const fixture = path.join(cwd, '.playwright', 'lighthouse-fixture')
    const env = lighthouseEnvironment(fixture, {
      DATABASE_URL: 'file:./accounting.db', DOCUMENT_STORAGE_DRIVER: 's3', DOCUMENT_STORAGE_ROOT: './storage',
      AUTH_MODE: 'credentials', PORT: '3000', LHCI_COLLECT__URL: 'http://localhost:3000',
      LHCI_UPLOAD__TARGET: 'temporary-public-storage',
      LHCITEST_MOCK_LHR: '{"categories":{"performance":{"score":1}}}',
    }, cwd)
    expect(env).toMatchObject({
      DATABASE_URL: 'file:./.playwright/lighthouse-fixture/lighthouse.db',
      DOCUMENT_STORAGE_DRIVER: 'fs', DOCUMENT_STORAGE_ROOT: path.join(fixture, 'documents'),
      AUTH_MODE: 'none', APP_BIND_HOST: '127.0.0.1', PORT: '3234', NODE_ENV: 'production', DISPOSABLE_DATABASE: 'true',
    })
    expect(Object.keys(env).filter(key => key.startsWith('LHCI_') || key.startsWith('LHCITEST_'))).toEqual([])
    expect(() => lighthouseEnvironment(cwd, {}, cwd)).toThrow(/fresh .playwright/)
    expect(() => lighthouseEnvironment(fixture, { COMPANY_DATABASE_FILE: path.join(fixture, 'lighthouse.db') }, cwd)).toThrow(/company database/)
  })

  test('given an occupied port, when preparing QA, then it fails without making a request to the existing server', async () => {
    let connections = 0
    const server = createServer(() => { connections += 1 })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    try {
      await expect(assertPortAvailable(address.port)).rejects.toThrow(/refusing to reuse/)
      expect(connections).toBe(0)
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    await expect(assertPortAvailable(address.port)).resolves.toBeUndefined()
  })

  test('given the Quality workflow, when a Lighthouse gate fails, then it retains reports and fails the job', async () => {
    const workflow = await readFile(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8')
    const job = workflow.split('  lighthouse:\n')[1].split('  xrechnung-contract:')[0]
    expect(job).toContain('pnpm test:lighthouse')
    expect(job).not.toContain('continue-on-error')
    expect(job).toContain('if: always()')
    expect(job).toContain('include-hidden-files: true')
    expect(job).toContain('lighthouse-reports/')
    expect(job).toContain('.lighthouseci/')
  })
})

describe('enforced Lighthouse budgets', () => {
  test.each([
    { category: 'performance', scores: [0.2, 0.8, 0.9], passes: true },
    { category: 'performance', scores: [0.2, 0.79, 0.9], passes: false },
    { category: 'accessibility', scores: [0.9, 1, 1], passes: true },
    { category: 'accessibility', scores: [0.89, 1, 1], passes: false },
    { category: 'best-practices', scores: [0.95, 1, 1], passes: true },
    { category: 'best-practices', scores: [0.94, 1, 1], passes: false },
    { category: 'http-status-code', scores: [0, 1, 1], passes: false },
    { category: 'errors-in-console', scores: [0, 1, 1], passes: false },
  ])('given $category scores $scores, when LHCI asserts the actual config, then passing is $passes', async ({ category, scores, passes }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'accounting-lighthouse-test-'))
    temporaryDirectories.push(directory)
    const reports = path.join(directory, '.lighthouseci')
    await mkdir(reports)
    for (const [index, score] of scores.entries()) {
      const categories = { performance: { score: 1 }, accessibility: { score: 1 }, 'best-practices': { score: 1 } }
      const audits = { 'http-status-code': { score: 1 }, 'errors-in-console': { score: 1 } }
      if (category in categories) categories[category as keyof typeof categories].score = score
      else audits[category as keyof typeof audits].score = score
      await writeFile(path.join(reports, `lhr-${index}.json`), JSON.stringify({
        requestedUrl: 'http://127.0.0.1:3234/', finalUrl: 'http://127.0.0.1:3234/', categories, audits,
      }))
    }
    const result = spawnSync(process.execPath, [
      path.resolve('node_modules/@lhci/cli/src/cli.js'), 'assert', `--config=${path.resolve('lighthouserc.cjs')}`,
    ], { cwd: directory, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LHCI_'))), encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(passes ? 0 : 1)
    const assertions = JSON.parse(await readFile(path.join(reports, 'assertion-results.json'), 'utf8')) as { auditId: string; passed: boolean }[]
    if (!passes) expect(assertions.some(assertion => !assertion.passed)).toBe(true)
  }, 30_000)
})
