import { getJSON } from './Requester'

export interface InvoiceIssuanceIntent {
  path: string
  originalNumber?: string
  payload: {
    requestKey: string; kind: 'invoice' | 'credit-note'; issueDate: string
    buyer: { name: string }; grossAmountCents: number; currency: string
    [key: string]: unknown
  }
}

type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** One immutable wire request per browser tab, tenant and actor. */
export class InvoiceIssuanceIntentStore {
  private serialized: string | null
  private running = false

  get sending() { return this.running }

  constructor(private readonly storage: IntentStorage, private readonly storageKey: string) {
    this.serialized = storage.getItem(storageKey)
    if (this.serialized) this.read() // Corrupt recovery data must not silently start a new intent.
  }

  read(): InvoiceIssuanceIntent | null {
    if (!this.serialized) return null
    const value = JSON.parse(this.serialized) as InvoiceIssuanceIntent
    const validPath = value.payload?.kind === 'invoice'
      ? value.path === '/api/tax/e-invoices'
      : value.payload?.kind === 'credit-note' && /^\/api\/tax\/e-invoices\/[^/]+\/corrections$/.test(value.path)
    if (!validPath || !/^[A-Za-z0-9._:-]{16,100}$/.test(value.payload.requestKey)
      || typeof value.payload.buyer?.name !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.payload.issueDate)
      || !Number.isSafeInteger(value.payload.grossAmountCents) || !/^[A-Z]{3}$/.test(value.payload.currency)
      || value.payload.kind === 'credit-note' && typeof value.originalNumber !== 'string') throw new Error('The saved invoice request could not be recovered.')
    return value
  }

  capture(intent: InvoiceIssuanceIntent) {
    if (this.serialized) throw new Error('Recover the pending invoice request before starting another.')
    const serialized = JSON.stringify(intent)
    // Persist before sending; storage failures must prevent an unprotected POST.
    this.storage.setItem(this.storageKey, serialized)
    this.serialized = serialized
  }

  async replay(post: (path: string, payload: InvoiceIssuanceIntent['payload']) => Promise<Response>, failureMessage: string) {
    if (this.running) throw new Error('This invoice request is already being sent.')
    const intent = this.read()
    if (!intent) throw new Error('There is no invoice request to recover.')
    this.running = true
    try {
      const response = await post(intent.path, intent.payload)
      const body = await getJSON(response)
      if (response.ok && body?.success === true && typeof body.data?.id === 'string' && body.data.id && typeof body.data.invoiceNumber === 'string' && body.data.invoiceNumber) {
        this.clear()
        return { intent, invoiceNumber: body.data.invoiceNumber as string }
      }
      // HTTP status alone cannot prove that nothing was committed.
      if (response.status === 400 && body?.success === false && body.requestRejected === true) this.clear()
      const issues = Array.isArray(body?.issues) ? body.issues.filter((issue: unknown) => typeof issue === 'string').join(' ') : ''
      throw new Error(issues || failureMessage)
    } finally { this.running = false }
  }

  private clear() {
    // If clearing fails, keep the safe replay instead of risking a new operation.
    this.storage.removeItem(this.storageKey)
    this.serialized = null
  }
}

export function invoiceIntentStorageKey(ownerId: string, actorId: string) {
  return `invoice-issuance:${JSON.stringify([ownerId, actorId])}`
}
