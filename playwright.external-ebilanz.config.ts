import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3112'
export default defineConfig({
  testDir: './e2e', testMatch: 'external-ebilanz-real.spec.ts', fullyParallel: false, workers: 1,
  timeout: 180_000, reporter: [['list']], use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tools/e2e-dev.mjs external-ebilanz', url: baseURL, reuseExistingServer: false, timeout: 180_000,
    env: {
      DATABASE_URL: 'file:./external-playwright.db', E2E_DATABASE_FILE: 'external-playwright.db',
      E2E_DOCUMENT_STORAGE: './.playwright/external-documents', DOCUMENT_STORAGE_ROOT: './.playwright/external-documents',
      DOCUMENT_STORAGE_DRIVER: 'fs', DOCUMENT_STORAGE_REGION: 'DE', AUTH_MODE: 'credentials',
      BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: 'external-e2e-synthetic-auth-key-not-a-real-secret', BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      AUDIT_INTEGRITY_SECRET: 'external-e2e-synthetic-audit-key-not-a-real-secret',
      ERIC_QUALIFIED: 'false', E_BILANZ_ALLOW_UNQUALIFIED_DRAFTS: 'false', TAX_GATEWAY_URL: '', TAX_GATEWAY_CREDENTIAL: '',
      COMPLIANCE_E2E_REFERENCE_DATE: '2027-01-02',
    },
  },
})
