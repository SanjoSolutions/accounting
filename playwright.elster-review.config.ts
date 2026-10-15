import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3229'
export default defineConfig({
  testDir: './e2e',
  testMatch: 'elster-review.spec.ts',
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tools/e2e-dev.mjs elster-review',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: 'file:./elster-review-playwright.db',
      E2E_DATABASE_FILE: 'elster-review-playwright.db',
      DISPOSABLE_DATABASE: 'true',
      AUTH_MODE: 'credentials',
      BETTER_AUTH_URL: baseURL,
      BETTER_AUTH_SECRET: 'elster-review-synthetic-auth-key-only-2026',
      BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      AUDIT_INTEGRITY_SECRET: 'elster-review-synthetic-audit-key-only-2026',
      DOCUMENT_STORAGE_DRIVER: 'fs',
      DOCUMENT_STORAGE_ROOT: './.playwright/elster-review-documents',
      E2E_DOCUMENT_STORAGE: './.playwright/elster-review-documents',
      DOCUMENT_STORAGE_REGION: 'DE',
      TAX_GATEWAY_URL: '',
      TAX_GATEWAY_CREDENTIAL: '',
      ANNUAL_TAX_CALCULATOR_URL: '',
      ANNUAL_TAX_CALCULATOR_CREDENTIAL: '',
    },
  },
})
