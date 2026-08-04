import { defineConfig, devices } from '@playwright/test'

const baseURL = 'http://127.0.0.1:3110'

export default defineConfig({
  testDir: './e2e-local-solo',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev:e2e:local-solo',
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      DATABASE_URL: 'file:./playwright.db',
      DOCUMENT_STORAGE_DRIVER: 'fs',
      DOCUMENT_STORAGE_ROOT: './.playwright/solo-documents',
      DOCUMENT_STORAGE_REGION: 'DE',
    },
  },
})
