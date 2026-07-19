import { describe, expect, it } from 'vitest'
import { readSettingsResponse } from './Settings'

describe('settings loading', () => {
  it('finishes with a controlled error when the API response is empty', async () => {
    await expect(readSettingsResponse(new Response('', { status: 500 }))).rejects.toThrow('Settings could not be loaded')
  })

  it('returns valid settings data', async () => {
    const data = {
      invoiceIssuer: { name: '', streetAndHouseNumber: '', zipCode: '', city: '', country: '' },
      chartOfAccounts: 'SKR03',
    }
    await expect(readSettingsResponse(Response.json({ success: true, data }))).resolves.toEqual(data)
  })
})
