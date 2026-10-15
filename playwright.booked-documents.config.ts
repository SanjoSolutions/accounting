import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3223'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'booked-documents.spec.ts',
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { baseURL, ...devices['Desktop Chrome'], screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: {
    command: 'node e2e/booked-documents-server.mjs',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 240_000,
    env: {
      DATABASE_URL: 'file:./issue-23-playwright.db',
      E2E_DATABASE_FILE: 'issue-23-playwright.db',
      E2E_DOCUMENT_STORAGE: './.playwright/issue-23-documents',
      DOCUMENT_STORAGE_DRIVER: 'fs',
      DOCUMENT_STORAGE_ROOT: './.playwright/issue-23-documents',
      DOCUMENT_STORAGE_REGION: 'DE',
      DISPOSABLE_DATABASE: 'true',
      AUTH_MODE: 'none',
      APP_BIND_HOST: '127.0.0.1',
    },
  },
})
