import { defineConfig, devices } from '@playwright/test'
import path from 'node:path'

const baseURL = 'http://127.0.0.1:3100'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL,
    storageState: path.join('.playwright', 'auth.json'),
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm run dev:e2e',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: 'file:./playwright.db',
      AUTH_MODE: 'credentials',
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: 'playwright-only-secret-with-at-least-32-characters',
      BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      AUDIT_INTEGRITY_SECRET: 'playwright-only-audit-key-with-32-characters',
      DOCUMENT_STORAGE_DRIVER: 'fs',
      DOCUMENT_STORAGE_ROOT: './.playwright/documents',
    },
  },
})
