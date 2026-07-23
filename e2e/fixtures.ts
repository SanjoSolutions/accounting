import { test as base, expect } from '@playwright/test'
import {
  ApplicationPage,
  AuthenticationPage,
  BookingsPage,
  CompliancePage,
  SettingsPage,
  TaxPage,
} from './pages'

type Pages = {
  app: ApplicationPage
  authentication: AuthenticationPage
  bookings: BookingsPage
  compliance: CompliancePage
  settings: SettingsPage
  tax: TaxPage
}

export const test = base.extend<Pages>({
  app: async ({ page }, use) => use(new ApplicationPage(page)),
  authentication: async ({ page }, use) => use(new AuthenticationPage(page)),
  bookings: async ({ page }, use) => use(new BookingsPage(page)),
  compliance: async ({ page }, use) => use(new CompliancePage(page)),
  settings: async ({ page }, use) => use(new SettingsPage(page)),
  tax: async ({ page }, use) => use(new TaxPage(page)),
})

export { expect }
