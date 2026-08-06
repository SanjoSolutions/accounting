import { describe, expect, it } from 'vitest'
import { readSettingsResponse } from './Settings'

describe('settings loading', () => {
  it('finishes with a controlled error when the API response is empty', async () => {
    await expect(readSettingsResponse(new Response('', { status: 500 }))).rejects.toThrow('Settings could not be loaded')
  })

  it('returns valid settings data', async () => {
    const data = {
      invoiceIssuer: { name: '', streetAndHouseNumber: '', zipCode: '', city: '', country: '', contactName: 'Accounts receivable', contactTelephone: '+49 30 123456', contactEmail: 'billing@example.de' },
      chartOfAccounts: 'SKR03',
      incomingReverseChargeAccounts: { chart: 'SKR03', rateBasisPoints: 1900, inputVatAccountNumber: 1577, outputVatAccountNumber: 1787 },
      incomingEuAcquisitionAccounts: { chart: 'SKR03', rateBasisPoints: 1900, inputVatAccountNumber: 1574, outputVatAccountNumber: 1774 },
    }
    await expect(readSettingsResponse(Response.json({ success: true, data }))).resolves.toEqual(data)
  })
})
