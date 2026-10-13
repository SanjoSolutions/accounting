import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3126'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'invoice-retry-real.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { baseURL, ...devices['Desktop Chrome'], actionTimeout: 15_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node tools/e2e-dev.mjs invoice-retry', url: baseURL, reuseExistingServer: false, timeout: 180_000,
    env: {
      DATABASE_URL: 'file:./credit-retry-playwright.db', E2E_DATABASE_FILE: 'credit-retry-playwright.db',
      DOCUMENT_STORAGE_DRIVER: 'fs', DOCUMENT_STORAGE_ROOT: './.playwright/credit-retry/documents', DOCUMENT_STORAGE_REGION: 'DE',
      AUTH_MODE: 'credentials', BETTER_AUTH_URL: baseURL, BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      BETTER_AUTH_SECRET: 'credit-retry-test-only-secret-at-least-32-characters',
      AUDIT_INTEGRITY_SECRET: 'credit-retry-test-only-audit-key-at-least-32-characters',
    },
  },
})
