import { defineConfig, devices } from '@playwright/test'
const baseURL = 'http://127.0.0.1:3227'
export default defineConfig({
  testDir: './e2e', testMatch: 'euer-real.spec.ts', fullyParallel: false, workers: 1,
  reporter: [['list']], use: { baseURL, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tools/euer-e2e.mjs', url: baseURL, reuseExistingServer: false, timeout: 180000,
    env: { DATABASE_URL: 'file:./euer-playwright.db', E2E_DATABASE_FILE: 'euer-playwright.db', DISPOSABLE_DATABASE: 'true', AUTH_MODE: 'none', APP_BIND_HOST: '127.0.0.1', DOCUMENT_STORAGE_DRIVER: 'fs', DOCUMENT_STORAGE_ROOT: './.playwright/euer-documents', E2E_DOCUMENT_STORAGE: './.playwright/euer-documents', DOCUMENT_STORAGE_REGION: 'DE' },
  },
})
