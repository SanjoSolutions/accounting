import { defineConfig, devices } from '@playwright/test'

// This workflow owns port 3113, its disposable DB and its own document root.
const baseURL = 'http://127.0.0.1:3113'
export default defineConfig({
  testDir: './e2e', testMatch: 'annual-documents.spec.ts', workers: 1, retries: 0,
  reporter: [['list']], use: { baseURL, actionTimeout: 30_000, navigationTimeout: 60_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tools/e2e-dev.mjs annual-documents', url: baseURL, reuseExistingServer: false, timeout: 180_000,
    env: {
      DATABASE_URL: 'file:./annual-documents-playwright.db', E2E_DATABASE_FILE: 'annual-documents-playwright.db', DISPOSABLE_DATABASE: 'true',
      E2E_DOCUMENT_STORAGE: './.playwright/annual-documents', DOCUMENT_STORAGE_DRIVER: 'fs', DOCUMENT_STORAGE_ROOT: './.playwright/annual-documents', DOCUMENT_STORAGE_REGION: 'DE',
      AUTH_MODE: 'credentials', BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: 'annual-documents-test-only-auth-key-32', BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      AUDIT_INTEGRITY_SECRET: 'annual-documents-test-only-audit-key-32', COMPLIANCE_E2E_REFERENCE_DATE: '2027-03-03',
    },
  },
})
