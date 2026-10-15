import { describe, expect, test, vi } from 'vitest'
import { InvoiceIssuanceIntentStore, invoiceIntentStorageKey, type InvoiceIssuanceIntent } from './invoiceIssuanceIntent'

function memoryStorage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
const credit = (): InvoiceIssuanceIntent => ({ path: '/api/tax/e-invoices/original/corrections', originalNumber: '2026-000001', payload: { kind: 'credit-note', requestKey: 'credit-ui-intent-0001', issueDate: '2026-08-05', buyer: { name: 'Synthetic buyer' }, grossAmountCents: 2380, currency: 'EUR', lines: [{ description: 'Partial credit', netAmountCents: 2000 }] } })
const success = () => Response.json({ success: true, data: { id: 'credit-1', invoiceNumber: '2026-000002' } }, { status: 201 })

describe('immutable invoice issuance intents', () => {
  test.each(['timeout', 'network', 'json', 'empty', 'incomplete', 'server', 'business'])(
    'Given an uncertain %s response, when the user retries, then the original key, target and nested payload are replayed', async failure => {
      const storage = memoryStorage(); const store = new InvoiceIssuanceIntentStore(storage, 'intent')
      const draft = credit(); const original = structuredClone(draft); store.capture(draft)
      const requests: unknown[] = []
      const post = vi.fn(async (path, payload) => {
        requests.push({ path, payload })
        if (requests.length > 1) return success()
        if (failure === 'timeout') throw new DOMException('Timed out', 'TimeoutError')
        if (failure === 'network') throw new TypeError('Failed to fetch')
        if (failure === 'json') return new Response('{broken', { status: 201 })
        if (failure === 'empty') return new Response('', { status: 201 })
        if (failure === 'incomplete') return Response.json({ success: true, data: {} }, { status: 201 })
        return Response.json({ success: false, issues: ['Try again'] }, { status: failure === 'server' ? 503 : 400 })
      })
      await expect(store.replay(post, 'Unconfirmed')).rejects.toThrow()
      draft.payload.buyer.name = 'Edited buyer'; draft.payload.grossAmountCents = 5950
      ;(draft.payload.lines as Array<{ description: string }>)[0].description = 'Edited credit'
      expect(() => store.capture(draft)).toThrow(/Recover/)
      store.read()!.payload.buyer.name = 'Mutated read result'
      await expect(store.replay(post, 'Unconfirmed')).resolves.toMatchObject({ invoiceNumber: '2026-000002' })
      expect(requests).toEqual([original, original].map(({ path, payload }) => ({ path, payload })))
      expect(store.read()).toBeNull(); expect(storage.getItem('intent')).toBeNull()
    },
  )

  test('Given a lost response and a reload, when the saved request is recovered, then it remains scoped to the same tenant and actor', async () => {
    const storage = memoryStorage(); const key = invoiceIntentStorageKey('tenant-a', 'actor-a')
    new InvoiceIssuanceIntentStore(storage, key).capture(credit())
    expect(new InvoiceIssuanceIntentStore(storage, invoiceIntentStorageKey('tenant-b', 'actor-a')).read()).toBeNull()
    expect(new InvoiceIssuanceIntentStore(storage, invoiceIntentStorageKey('tenant-a', 'actor-b')).read()).toBeNull()
    const restored = new InvoiceIssuanceIntentStore(storage, key)
    const post = vi.fn(async () => success())
    await restored.replay(post, 'Unconfirmed')
    expect(post).toHaveBeenCalledWith(credit().path, credit().payload)
  })

  test('Given a definitive server rejection, when the key is retired, then edited facts receive a new intent', async () => {
    const store = new InvoiceIssuanceIntentStore(memoryStorage(), 'intent'); store.capture(credit())
    await expect(store.replay(async () => Response.json({ success: false, requestRejected: true, issues: ['Exceeds original'] }, { status: 400 }), 'Unconfirmed')).rejects.toThrow('Exceeds original')
    expect(store.read()).toBeNull()
    const revised = credit(); revised.payload.requestKey = 'credit-ui-intent-0002'; revised.payload.grossAmountCents = 1190
    store.capture(revised)
    expect(store.read()).toEqual(revised)
  })

  test('Given an ordinary invoice, when its outcome is uncertain, then it uses the same immutable recovery contract', async () => {
    const store = new InvoiceIssuanceIntentStore(memoryStorage(), 'intent')
    const invoice = credit(); invoice.path = '/api/tax/e-invoices'; invoice.payload.kind = 'invoice'
    store.capture(invoice)
    await expect(store.replay(async () => { throw new Error('Lost response') }, 'Unconfirmed')).rejects.toThrow('Lost response')
    const post = vi.fn(async () => success()); await store.replay(post, 'Unconfirmed')
    expect(post).toHaveBeenCalledWith(invoice.path, invoice.payload)
  })

  test('Given a request in flight, when a second submit occurs, then only one POST is sent', async () => {
    const store = new InvoiceIssuanceIntentStore(memoryStorage(), 'intent'); store.capture(credit())
    let finish!: (response: Response) => void
    const post = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    const first = store.replay(post, 'Unconfirmed')
    await expect(store.replay(post, 'Unconfirmed')).rejects.toThrow(/already being sent/)
    finish(success()); await first
    expect(post).toHaveBeenCalledOnce()
  })

  test('Given unavailable or corrupt storage, when a request is prepared, then issuance fails closed', () => {
    const storage = memoryStorage()
    const store = new InvoiceIssuanceIntentStore({ ...storage, setItem: () => { throw new Error('Storage full') } }, 'intent')
    expect(() => store.capture(credit())).toThrow('Storage full'); expect(store.read()).toBeNull()
    storage.setItem('intent', '{broken')
    expect(() => new InvoiceIssuanceIntentStore(storage, 'intent')).toThrow()
  })

  test('Given confirmation but unavailable storage removal, when completing, then the request stays recoverable', async () => {
    const store = new InvoiceIssuanceIntentStore({ ...memoryStorage(), removeItem: () => { throw new Error('Storage unavailable') } }, 'intent')
    store.capture(credit())
    await expect(store.replay(async () => success(), 'Unconfirmed')).rejects.toThrow('Storage unavailable')
    expect(store.read()).toEqual(credit())
  })

  test('Given an invalid request summary, when capture fails, then corrected facts can still be submitted', () => {
    const storage = memoryStorage(); const store = new InvoiceIssuanceIntentStore(storage, 'intent')
    const invalid = credit(); invalid.payload.grossAmountCents = Number.MAX_SAFE_INTEGER + 1
    expect(() => store.capture(invalid)).toThrow(/could not be recovered/)
    expect(store.read()).toBeNull(); expect(storage.getItem('intent')).toBeNull()
    store.capture(credit())
    expect(store.read()).toEqual(credit())
  })

  test('Given a confirmed intent, when a new operation starts, then its facts and key may change', async () => {
    const store = new InvoiceIssuanceIntentStore(memoryStorage(), 'intent'); store.capture(credit())
    await store.replay(async () => success(), 'Unconfirmed')
    const next = credit(); next.payload.requestKey = 'credit-ui-intent-0002'; next.payload.grossAmountCents = 1190
    store.capture(next)
    expect(store.read()).toEqual(next)
  })

  test.each([{ path: 'https://example.test/collect' }, { payload: {} }])('Given invalid saved recovery data %j, when restoring, then it cannot be sent or silently discarded', invalid => {
    const storage = memoryStorage(); const serialized = JSON.stringify({ ...credit(), ...invalid }); storage.setItem('intent', serialized)
    expect(() => new InvoiceIssuanceIntentStore(storage, 'intent')).toThrow(/could not be recovered/)
    expect(storage.getItem('intent')).toBe(serialized)
  })
})
