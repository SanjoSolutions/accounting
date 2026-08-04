import { expect, test } from '@playwright/test'

test.describe('localhost solo mode', () => {
  test('Given the one-command solo launcher, when no credentials or cookies are supplied, then the real app and API are usable without a sign-in screen', async ({ page, request }) => {
    const settings = await request.get('/api/settings')
    expect(settings.status()).toBe(200)
    await expect(settings.json()).resolves.toMatchObject({ success: true })

    const response = await page.goto('/')
    expect(response?.status()).toBe(200)
    await expect(page).toHaveURL('http://127.0.0.1:3110/')
    await expect(page.locator('a[href="/bookings"]')).toBeVisible()
    await expect(page.locator('a[href="/sign-in"]')).toHaveCount(0)
    await expect(page.locator('form[action*="sign-out"], button').filter({ hasText: /sign out|abmelden/i })).toHaveCount(0)

    await page.goto('/sign-in')
    await expect(page).toHaveURL('http://127.0.0.1:3110/')
  })
})
