import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3124'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['document-extraction-real.spec.ts', 'document-extraction-recovery.spec.ts'],
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: 'list',
  use: { baseURL, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  webServer: {
    command: 'node e2e/prepare-database.mjs && node tools/guarded-prisma.mjs migrate deploy && pnpm exec next dev --hostname 127.0.0.1 --port 3124',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: 'file:./extraction-playwright.db',
      E2E_DATABASE_FILE: 'extraction-playwright.db',
      DISPOSABLE_DATABASE: 'true',
      AUTH_MODE: 'credentials',
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: 'extraction-playwright-only-secret-32-characters',
      BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      AUDIT_INTEGRITY_SECRET: 'extraction-playwright-only-audit-key-32-characters',
      DOCUMENT_STORAGE_DRIVER: 'fs',
      DOCUMENT_STORAGE_ROOT: './.playwright/extraction-documents',
      E2E_DOCUMENT_STORAGE: './.playwright/extraction-documents',
      DOCUMENT_STORAGE_REGION: 'DE',
    },
  },
})
