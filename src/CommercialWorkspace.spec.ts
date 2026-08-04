import { describe, expect, it } from 'vitest'
import { formatMinorUnits, readCommercialList } from './CommercialWorkspace'

describe('commercial workspace response boundary', () => {
  it('Given a valid tenant list response, when it is parsed, then rows are returned', async () => {
    await expect(readCommercialList<{ id: string }>(Response.json({ success: true, data: [{ id: 'partner-a' }] }))).resolves.toEqual([{ id: 'partner-a' }])
  })

  it('Given malformed or failed API data, when it is parsed, then the UI fails closed with a useful error', async () => {
    await expect(readCommercialList(Response.json({ success: true, data: {} }))).rejects.toThrow(/could not be loaded/)
    await expect(readCommercialList(Response.json({ success: false, error: 'Tenant failure' }, { status: 400 }))).rejects.toThrow(/Tenant failure/)
  })

  it('Given integer euro cents, when an amount is rendered, then precision is retained', () => {
    expect(formatMinorUnits(11_900, 'EUR', 'en-US')).toBe('€119.00')
    expect(() => formatMinorUnits(0.5, 'EUR')).toThrow(/safe minor-unit/)
  })
})
