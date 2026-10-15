import { test, expect } from '@playwright/test'
import { SmallBusinessPage } from './small-business-page'

test('Given a dated Kleinunternehmer UG profile without a VAT ID, when an invoice and partial credit are issued, then exemption evidence and both documents survive reload', async ({ page, baseURL }) => {
  expect(baseURL).toBe('http://127.0.0.1:3228')
  const flow = new SmallBusinessPage(page)
  await flow.configure()
  await flow.issueAndCredit()
})
