import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { databaseUrlForPath, isProtectedDatabasePath } from './db-safety.mjs'
import configuration from './lighthouse-config.cjs'

const { lighthousePort, createLighthouseConfig } = configuration
const projectRoot = fileURLToPath(new URL('../', import.meta.url))

export async function assertPortAvailable(port) {
  // Binding, rather than requesting a URL, never touches an existing app.
  const probe = createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', () => reject(new Error(`Lighthouse port ${port} is unavailable; refusing to reuse an existing server.`)))
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, resolve)
  })
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
}

export function lighthouseEnvironment(fixtureDirectory, env = process.env, cwd = projectRoot) {
  const fixture = path.resolve(fixtureDirectory)
  if (path.dirname(fixture) !== path.join(cwd, '.playwright') || !path.basename(fixture).startsWith('lighthouse-')) {
    throw new Error('Lighthouse fixtures must be in a fresh .playwright/lighthouse-* directory.')
  }
  const databasePath = path.join(fixture, 'lighthouse.db')
  if (isProtectedDatabasePath(databasePath, { cwd, env })) throw new Error('Lighthouse cannot use the company database.')
  const port = lighthousePort(env)
  return {
    // Ignore LHCI environment overrides so collect cannot target a different app
    // or upload reports to an external service.
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('LHCI_'))),
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrlForPath(databasePath, cwd),
    DISPOSABLE_DATABASE: 'true',
    AUTH_MODE: 'none',
    APP_BIND_HOST: '127.0.0.1',
    PORT: String(port),
    LIGHTHOUSE_PORT: String(port),
    BETTER_AUTH_URL: `http://127.0.0.1:${port}`,
    AUDIT_INTEGRITY_SECRET: 'lighthouse-disposable-fixture-only-32-characters',
    DOCUMENT_STORAGE_DRIVER: 'fs',
    DOCUMENT_STORAGE_ROOT: path.join(fixture, 'documents'),
    DOCUMENT_STORAGE_REGION: 'DE',
    NEXT_TELEMETRY_DISABLED: '1',
  }
}

function run(script, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { ...options, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(script)} ${args.join(' ')} failed (${signal ?? code}).`))
    })
  })
}

function waitForReady(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Lighthouse app did not become ready within 60 seconds.')), 60_000)
    let output = ''
    child.stdout.on('data', chunk => {
      process.stdout.write(chunk)
      output = (output + chunk.toString()).slice(-4096)
      if (/Ready in/.test(output)) { clearTimeout(timer); resolve() }
    })
    child.stderr.on('data', chunk => process.stderr.write(chunk))
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Lighthouse app exited before the audit finished (${code}).`)) })
  })
}

export async function runLighthouse() {
  const port = lighthousePort()
  await assertPortAvailable(port)
  const fixtureParent = path.join(projectRoot, '.playwright')
  await mkdir(fixtureParent, { recursive: true })
  const fixture = await mkdtemp(path.join(fixtureParent, 'lighthouse-'))
  const env = lighthouseEnvironment(fixture)
  await mkdir(env.DOCUMENT_STORAGE_ROOT, { recursive: true })
  console.log(`[lighthouse] Isolated app: http://127.0.0.1:${port}`)
  console.log(`[lighthouse] Disposable database: ${env.DATABASE_URL}`)
  console.log(`[lighthouse] Isolated document storage: ${env.DOCUMENT_STORAGE_ROOT}`)

  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  const options = { cwd: projectRoot, env, signal: controller.signal }
  const prisma = path.join(projectRoot, 'node_modules/prisma/build/index.js')
  const next = path.join(projectRoot, 'node_modules/next/dist/bin/next')
  const lhci = path.join(projectRoot, 'node_modules/@lhci/cli/src/cli.js')
  let server
  try {
    await run(prisma, ['migrate', 'deploy'], options)
    await run(prisma, ['generate'], options)
    await run(next, ['build'], options)
    // A build can take minutes. Check again before starting our own server.
    await assertPortAvailable(port)
    server = spawn(process.execPath, [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
      ...options, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    })
    await waitForReady(server)
    for (const url of createLighthouseConfig(env).ci.collect.url) {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]) })
      await response.body?.cancel()
      if (response.status !== 200) throw new Error(`Lighthouse target ${url} returned HTTP ${response.status}.`)
    }
    // Explicit commands avoid autorun's server autodetection. Export before
    // asserting so failing quality gates still leave reviewable HTML/JSON.
    for (const command of ['collect', 'upload', 'assert']) {
      await run(lhci, [command, '--config=./lighthouserc.cjs'], options)
    }
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, 'exit').catch(() => {})
      server.kill()
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000)
      await stopped
      clearTimeout(force)
    }
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
    // Keep this run's fixtures for debugging. They are ignored by Git and are
    // never reused or reset, including after an interrupted run.
    console.log(`[lighthouse] Disposable fixtures retained at ${fixture}`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runLighthouse().catch(error => { console.error(error); process.exitCode = 1 })
}
