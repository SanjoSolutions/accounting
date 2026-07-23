import { test, expect } from './fixtures'
import { e2eUser } from './global-setup'

test.use({ storageState: { cookies: [], origins: [] } })

test.describe('authentication', () => {
  test('signing in and signing out', async ({ authentication, page }) => {
    await authentication.open('/sign-in')
    await authentication.signIn(e2eUser.email, e2eUser.password)

    await expect(page).toHaveURL('/')
    await expect(page.getByText(e2eUser.email)).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()
    await expect(page).toHaveURL('/sign-in')
  })

  test('creating a new account', async ({ authentication, page }) => {
    await authentication.open('/sign-up')
    await authentication.signUp(
      'New Playwright User',
      `new-${Date.now()}-${test.info().parallelIndex}@example.test`,
      'New-playwright-password-2026!',
    )

    await expect(page).toHaveURL('/')
    await expect(page.getByText(/new-.*@example\.test/)).toBeVisible()
  })
})
