import { afterEach, expect, test, vi } from 'vitest'
import { Requester } from './Requester'

afterEach(() => vi.unstubAllGlobals())

test('Given an issuance timeout signal, when posting JSON, then fetch receives the same signal and exact payload', async () => {
  const fetcher = vi.fn(async () => Response.json({ success: true }))
  vi.stubGlobal('fetch', fetcher)
  const signal = new AbortController().signal
  await new Requester('').post('/api/tax/e-invoices', { requestKey: 'invoice-request-01' }, signal)
  expect(fetcher).toHaveBeenCalledWith('/api/tax/e-invoices', expect.objectContaining({ method: 'POST', signal, body: '{"requestKey":"invoice-request-01"}' }))
})
