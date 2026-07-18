import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

export interface SemanticDelta { before?: unknown; after?: unknown; fields: string[] }
export interface AuditEvent { id: string; ownerId: string; actorId: string; occurredAt: string; action: string; reason: string; objectType: string; objectId: string; delta: SemanticDelta; previousHash?: string; hash: string }
export interface JournalLine { accountId: string; debitCents: number; creditCents: number; taxCode?: string }
export interface PostedEntry { id: string; ownerId: string; fiscalPeriodId: string; bookingDate: string; entryDate: string | null; state: 'POSTED'; lines: JournalLine[]; lateReason?: string; reversalOfId?: string; replacementOfId?: string }

const stable = (value: unknown): string => {
  if (value === null) return 'null'
  if (value === undefined) return '{"$undefined":true}'
  if (typeof value === 'bigint') return `{"$bigint":${JSON.stringify(value.toString())}}`
  if (typeof value === 'number' && !Number.isFinite(value)) return `{"$number":${JSON.stringify(String(value))}}`
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'function' || typeof value === 'symbol') throw new TypeError('Audit delta contains an unsupported value')
  if (value && typeof value === 'object') return Array.isArray(value) ? `[${value.map(stable).join(',')}]` : `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  throw new TypeError('Audit delta contains an unsupported value')
}
const signature = (event: Omit<AuditEvent, 'hash'>, secret: string) => createHmac('sha256', secret).update(stable(event)).digest('hex')

export class AppendOnlyAuditLog {
  readonly #events: AuditEvent[] = []
  constructor(private readonly secret: string) { if (secret.length < 32) throw new Error('Audit integrity secret must contain at least 32 characters') }
  append(input: Omit<AuditEvent, 'id' | 'occurredAt' | 'previousHash' | 'hash'>, occurredAt = new Date().toISOString()): AuditEvent {
    if (![input.ownerId, input.actorId, input.action, input.reason, input.objectType, input.objectId].every(value => typeof value === 'string' && value.trim())) throw new Error('Complete nonblank audit context and reason are required')
    const previousHash = [...this.#events].reverse().find(event => event.ownerId === input.ownerId)?.hash
    const unsigned = { ...input, id: randomUUID(), occurredAt, ...(previousHash ? { previousHash } : {}) }
    const hash = signature(unsigned, this.secret)
    const event = Object.freeze({ ...unsigned, delta: structuredClone(unsigned.delta), hash })
    this.#events.push(event); return structuredClone(event)
  }
  list(ownerId: string): AuditEvent[] { return this.#events.filter(event => event.ownerId === ownerId).map(event => structuredClone(event)) }
  verify(ownerId?: string): boolean {
    const previousByOwner = new Map<string, string>()
    return this.#events.filter(event => ownerId === undefined || event.ownerId === ownerId).every(event => {
      const { hash, ...unsigned } = event
      if (unsigned.previousHash !== previousByOwner.get(event.ownerId)) return false
      const valid = timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(signature(unsigned, this.secret), 'hex'))
      if (valid) previousByOwner.set(event.ownerId, hash)
      return valid
    })
  }
}

export function createStorno(original: PostedEntry, id: string, entryDate: string, reason: string): PostedEntry & { reason: string } {
  if (!reason.trim()) throw new Error('Storno reason is required')
  const { reversalOfId: _reversal, replacementOfId: _replacement, ...base } = structuredClone(original)
  return { ...base, id, entryDate, reversalOfId: original.id, reason, lines: original.lines.map(line => ({ ...line, debitCents: line.creditCents, creditCents: line.debitCents })) }
}
export function createReplacement(original: PostedEntry, reversal: PostedEntry, replacement: Omit<PostedEntry, 'replacementOfId'>): PostedEntry {
  if (original.ownerId !== reversal.ownerId || original.ownerId !== replacement.ownerId) throw new Error('Correction links cannot cross tenant boundaries')
  if (reversal.reversalOfId !== original.id) throw new Error('Replacement requires linked Storno')
  return { ...replacement, replacementOfId: original.id }
}
export function validateLateBooking(entry: PostedEntry, periodEndsAt: string): string[] {
  if (!entry.entryDate) return ['Historic entry date is unknown; document it before assessing late-booking exceptions']
  return entry.entryDate.slice(0, 10) > periodEndsAt && !entry.lateReason?.trim() ? ['Late booking exception reason is required'] : []
}

export interface ReopenRequest { id: string; ownerId: string; periodId: string; requestedBy: string; reason: string; status: 'PENDING' | 'APPROVED' | 'REJECTED'; approvedBy?: string }
export function approveReopen(request: ReopenRequest, approverId: string): ReopenRequest {
  if (request.status !== 'PENDING') throw new Error('Reopen request was already decided')
  if (request.requestedBy === approverId) throw new Error('Four-eyes approval is required')
  return { ...request, status: 'APPROVED', approvedBy: approverId }
}
export interface FilingAttempt { id: string; ownerId: string; kind: 'VAT' | 'E_BILANZ'; originalId?: string; request: string; response?: string; receipt?: string }
export function createAmendment(original: FilingAttempt, id: string, request: string): FilingAttempt {
  if (original.originalId) throw new Error('Amendment must reference the original filing')
  if (!original.response || !original.receipt) throw new Error('Original response and receipt must be retained before amendment')
  return { id, ownerId: original.ownerId, kind: original.kind, originalId: original.id, request }
}
