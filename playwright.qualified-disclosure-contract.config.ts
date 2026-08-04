import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testMatch: 'qualified-disclosure-gateway.contract.spec.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  reporter: [['list']],
})
