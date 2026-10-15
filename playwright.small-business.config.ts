import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3228'
export default defineConfig({
  testDir: './e2e', testMatch: 'small-business.spec.ts', workers: 1, retries: 0, timeout: 120_000,
  reporter: [['list']],
  use: { baseURL, ...devices['Desktop Chrome'], trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node tools/e2e-dev.mjs small-business', url: baseURL, reuseExistingServer: false, timeout: 180_000,
    env: {
      DATABASE_URL: 'file:./issue-28-playwright.db', E2E_DATABASE_FILE: 'issue-28-playwright.db',
      E2E_DOCUMENT_STORAGE: './.playwright/issue-28-documents', DOCUMENT_STORAGE_DRIVER: 'fs', DOCUMENT_STORAGE_ROOT: './.playwright/issue-28-documents', DOCUMENT_STORAGE_REGION: 'DE',
      AUTH_MODE: 'credentials', BETTER_AUTH_URL: baseURL, BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      BETTER_AUTH_SECRET: 'synthetic-issue-28-auth-key-for-testing-only', AUDIT_INTEGRITY_SECRET: 'synthetic-issue-28-audit-key-for-testing-only',
    },
  },
})
