import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3110'
export default defineConfig({
  testDir: './e2e', testMatch: ['ug-close-2026.spec.ts', 'independent-close-regression.spec.ts'], workers: 1, fullyParallel: false,
  reporter: [['list']], use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tools/e2e-dev.mjs ug-close', url: baseURL, reuseExistingServer: false, timeout: 180_000,
    env: {
      DATABASE_URL: 'file:./ug-close-playwright.db', E2E_DATABASE_FILE: 'ug-close-playwright.db', DISPOSABLE_DATABASE: 'true',
      AUTH_MODE: 'credentials', BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: 'ug-close-synthetic-test-only-32-characters', BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      AUDIT_INTEGRITY_SECRET: 'ug-close-synthetic-audit-test-only-32-characters',
      DOCUMENT_STORAGE_DRIVER: 'fs', DOCUMENT_STORAGE_ROOT: './.playwright/ug-close-documents', E2E_DOCUMENT_STORAGE: './.playwright/ug-close-documents', DOCUMENT_STORAGE_REGION: 'DE',
      COMPLIANCE_E2E_REFERENCE_DATE: '2027-02-01',
    },
  },
})
