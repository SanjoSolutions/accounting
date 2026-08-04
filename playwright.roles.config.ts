import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3120'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: { baseURL, trace: 'on-first-retry', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/prepare-database.mjs && prisma db push && prisma generate && next dev --hostname 127.0.0.1 --port 3120',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: 'file:./roles-playwright.db',
      E2E_DATABASE_FILE: 'roles-playwright.db',
      E2E_DOCUMENT_STORAGE: '.playwright/roles-documents',
      AUTH_MODE: 'credentials',
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: 'playwright-only-secret-with-at-least-32-characters',
      BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      AUDIT_INTEGRITY_SECRET: 'playwright-only-audit-key-with-32-characters',
      DOCUMENT_STORAGE_DRIVER: 'fs',
      DOCUMENT_STORAGE_ROOT: './.playwright/roles-documents',
      DOCUMENT_STORAGE_REGION: 'DE',
    },
  },
})
