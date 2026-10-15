import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3224'
export default defineConfig({
  testDir: './e2e', testMatch: 'document-search.spec.ts', workers: 1, retries: 0, timeout: 180_000,
  reporter: [['list']],
  use: { baseURL, actionTimeout: 30_000, navigationTimeout: 60_000, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tools/e2e-dev.mjs document-search', url: baseURL, reuseExistingServer: false, timeout: 240_000,
    env: {
      DATABASE_URL: 'file:./document-search-playwright.db', E2E_DATABASE_FILE: 'document-search-playwright.db', DISPOSABLE_DATABASE: 'true',
      E2E_DOCUMENT_STORAGE: './.playwright/document-search-documents', DOCUMENT_STORAGE_DRIVER: 'fs', DOCUMENT_STORAGE_ROOT: './.playwright/document-search-documents', DOCUMENT_STORAGE_REGION: 'DE',
      AUTH_MODE: 'credentials', BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: 'document-search-test-only-auth-key-32', BETTER_AUTH_DISABLE_SIGN_UP: 'false',
      AUDIT_INTEGRITY_SECRET: 'document-search-test-only-audit-key-32',
      DOCUMENT_SEARCH_OCR_COMMAND: process.env.DOCUMENT_SEARCH_TEST_OCR_COMMAND ?? '', DOCUMENT_SEARCH_OCR_LANGUAGES: 'eng',
    },
  },
})
