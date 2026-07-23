import { request, type FullConfig } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const e2eUser = {
  email: 'playwright@example.test',
  password: 'Playwright-password-2026!',
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL as string
  const context = await request.newContext({ baseURL })

  await context.post('/api/auth/sign-up/email', {
    data: { ...e2eUser, name: 'Playwright User' },
  })
  await context.post('/api/auth/sign-in/email', { data: e2eUser })

  const authDirectory = path.resolve('.playwright')
  await mkdir(authDirectory, { recursive: true })
  const storageState = await context.storageState()
  storageState.cookies.push({
    name: 'NEXT_LOCALE',
    value: 'en',
    domain: '127.0.0.1',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax',
  })
  await writeFile(path.join(authDirectory, 'auth.json'), JSON.stringify(storageState, null, 2))
  await context.dispose()
}
