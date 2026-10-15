import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3225'

export default defineConfig({
  testDir: './e2e',
  testMatch: ['booking-batches-real.spec.ts', 'accounting.spec.ts'],
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  globalSetup: './e2e/global-setup.ts',
  reporter: [['list']],
  use: { baseURL, storageState: '.playwright/auth.json', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tools/e2e-dev.mjs booking-batches',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      DATABASE_URL: 'file:./booking-batches-playwright.db',
      E2E_DATABASE_FILE: 'booking-batches-playwright.db',
      E2E_DOCUMENT_STORAGE: './.playwright/booking-batches-documents',
      DOCUMENT_STORAGE_DRIVER: 'fs',
      DOCUMENT_STORAGE_ROOT: './.playwright/booking-batches-documents',
      DOCUMENT_STORAGE_REGION: 'DE',
      AUTH_MODE: 'credentials',
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: 'booking-batches-test-only-secret-at-least-32-characters',
      BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      AUDIT_INTEGRITY_SECRET: 'booking-batches-test-only-audit-integrity-key',
    },
  },
})
