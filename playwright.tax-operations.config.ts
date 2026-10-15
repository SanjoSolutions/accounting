import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3221'
export default defineConfig({
  testDir: './e2e', testMatch: 'tax-onboarding.spec.ts', workers: 1, retries: 0,
  reporter: [['list']], timeout: 120_000,
  expect: { timeout: 30_000 },
  use: { baseURL, actionTimeout: 30_000, navigationTimeout: 60_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tools/e2e-dev.mjs tax-operations', url: baseURL, reuseExistingServer: false, timeout: 240_000,
    env: {
      DATABASE_URL: 'file:./tax-operations-playwright.db', E2E_DATABASE_FILE: 'tax-operations-playwright.db', DISPOSABLE_DATABASE: 'true',
      E2E_DOCUMENT_STORAGE: './.playwright/tax-operations', DOCUMENT_STORAGE_DRIVER: 'fs', DOCUMENT_STORAGE_ROOT: './.playwright/tax-operations', DOCUMENT_STORAGE_REGION: 'DE',
      AUTH_MODE: 'credentials', BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: 'tax-operations-test-only-auth-key-32', BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      AUDIT_INTEGRITY_SECRET: 'tax-operations-test-only-audit-key-32',
      TAX_PRODUCTION_FILING_ENABLED: 'false',
    },
  },
})
