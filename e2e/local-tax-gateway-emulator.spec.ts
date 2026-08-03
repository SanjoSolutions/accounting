import { expect, test } from '@playwright/test'

test('identifies the default tax transport as a local lifecycle emulator', async ({ request }) => {
  const response = await request.get('http://127.0.0.1:3199/health')

  expect(response.ok()).toBe(true)
  await expect(response.json()).resolves.toEqual({
    ok: true,
    service: 'local-tax-lifecycle-emulator',
    officialInteroperability: false,
  })
})
