import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const temporaryDirectories: string[] = []

afterEach(async () => {
  const { prisma } = await import('@/server/persistence/client')
  await prisma.$disconnect()
  delete (globalThis as { prisma?: unknown }).prisma
  vi.unstubAllEnvs()
  vi.resetModules()

  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ))
})

describe('credential authentication flow', () => {
  it('registers, signs in, and accesses a protected API with the session cookie', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'accounting-auth-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'authentication.db')

    const database = new DatabaseSync(databasePath)
    for (const migration of [
      '20260716144316_init',
      '20260716151904_add_better_auth',
    ]) {
      const sql = await readFile(
        resolve(process.cwd(), 'prisma', 'migrations', migration, 'migration.sql'),
        'utf8',
      )
      database.exec(sql)
    }
    database.close()

    vi.stubEnv('AUTH_MODE', 'credentials')
    vi.stubEnv('BETTER_AUTH_URL', 'http://localhost')
    vi.stubEnv('BETTER_AUTH_SECRET', randomBytes(32).toString('hex'))
    vi.stubEnv('DATABASE_URL', `file:${databasePath.replaceAll('\\', '/')}`)

    const authRoute = await import('./route')
    const fields = Object.fromEntries([
      ['name', 'Authentication test'],
      ['email', 'auth@example.com'],
      ['password', 'correct-horse-battery-staple'],
    ])

    const signUpResponse = await authRoute.POST(jsonRequest(
      'http://localhost/api/auth/sign-up/email',
      fields,
    ))
    expect(signUpResponse.status).toBe(200)

    const signInResponse = await authRoute.POST(jsonRequest(
      'http://localhost/api/auth/sign-in/email',
      fields,
    ))
    expect(signInResponse.status).toBe(200)

    const sessionCookie = signInResponse.headers.get('set-cookie')?.split(';', 1)[0]
    expect(sessionCookie).toBeTruthy()

    const settingsRoute = await import('../../settings/route')
    const settingsResponse = await settingsRoute.GET(new Request(
      'http://localhost/api/settings',
      { headers: { cookie: sessionCookie! } },
    ))

    expect(settingsResponse.status).toBe(200)
    await expect(settingsResponse.json()).resolves.toMatchObject({
      success: true,
      data: { id: 'default' },
    })
  }, 20_000)
})

function jsonRequest(url: string, body: object): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
    },
    body: JSON.stringify(body),
  })
}
