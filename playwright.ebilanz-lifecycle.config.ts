import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3219'
export default defineConfig({
  testDir: './e2e', testMatch: 'ebilanz-lifecycle.spec.ts', workers: 1, fullyParallel: false,
  timeout: 180_000, reporter: [['list']],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tools/e2e-dev.mjs ebilanz-lifecycle', url: baseURL, reuseExistingServer: false, timeout: 240_000,
    env: {
      DATABASE_URL: 'file:./issue19-playwright.db', E2E_DATABASE_FILE: 'issue19-playwright.db',
      DOCUMENT_STORAGE_ROOT: './.playwright/issue19-documents', E2E_DOCUMENT_STORAGE: './.playwright/issue19-documents',
      DOCUMENT_STORAGE_DRIVER: 'fs', DOCUMENT_STORAGE_REGION: 'DE', AUTH_MODE: 'credentials',
      BETTER_AUTH_URL: baseURL, BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      BETTER_AUTH_SECRET: 'issue19-synthetic-test-auth-value-not-production',
      AUDIT_INTEGRITY_SECRET: 'issue19-synthetic-test-audit-value-not-production',
      ERIC_QUALIFIED: 'false', TAX_GATEWAY_URL: '', TAX_GATEWAY_CREDENTIAL: '',
    },
  },
})
