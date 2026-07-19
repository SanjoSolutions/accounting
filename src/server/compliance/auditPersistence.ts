import { createHmac, randomUUID } from 'node:crypto'
import type { Prisma } from '@/generated/prisma/client'

type Transaction = Prisma.TransactionClient

function integrityKeyring(): { currentKeyId: string; keys: Record<string, string> } {
  if (process.env.AUDIT_INTEGRITY_KEYS) {
    const parsed: unknown = JSON.parse(process.env.AUDIT_INTEGRITY_KEYS)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.values(parsed).some(value => typeof value !== 'string' || value.length < 32)) throw new Error('AUDIT_INTEGRITY_KEYS must be a JSON object of keys containing at least 32 characters')
    const currentKeyId = process.env.AUDIT_INTEGRITY_KEY_ID
    if (!currentKeyId || !(currentKeyId in parsed)) throw new Error('AUDIT_INTEGRITY_KEY_ID must select a configured audit key')
    return { currentKeyId, keys: parsed as Record<string, string> }
  }
  const configured = process.env.AUDIT_INTEGRITY_SECRET
  if (configured && configured.length >= 32) return { currentKeyId: 'default', keys: { default: configured } }
  if (process.env.NODE_ENV === 'test') return { currentKeyId: 'default', keys: { default: 'local-audit-integrity-key-32-bytes!' } }
  throw new Error('AUDIT_INTEGRITY_SECRET must contain at least 32 characters')
}

function integritySecret(keyId: string): string {
  const secret = integrityKeyring().keys[keyId]
  if (!secret) throw new Error(`Audit integrity key ${keyId} is unavailable`)
  return secret
}

function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : JSON.stringify(String(value))
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  throw new TypeError('Audit values must be JSON-compatible')
}

function normalizeJson(value: unknown): unknown {
  if (value === undefined) return undefined
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new TypeError('Audit values must be JSON-compatible')
  return JSON.parse(serialized)
}

function changedFields(before: unknown, after: unknown): string[] {
  const left = before && typeof before === 'object' && !Array.isArray(before) ? before as Record<string, unknown> : {}
  const right = after && typeof after === 'object' && !Array.isArray(after) ? after as Record<string, unknown> : {}
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(key => canonical(left[key]) !== canonical(right[key])).sort()
}

export async function appendAuditEvent(transaction: Transaction, input: {
  ownerId: string
  actorId: string
  action: string
  reason: string
  objectType: string
  objectId: string
  before?: unknown
  after?: unknown
  occurredAt?: Date
}) {
  for (const [name, value] of Object.entries(input).filter(([name]) => ['ownerId', 'actorId', 'action', 'reason', 'objectType', 'objectId'].includes(name))) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required for audit`)
  }
  const occurredAt = input.occurredAt ?? new Date()
  const before = normalizeJson(input.before)
  const after = normalizeJson(input.after)
  await transaction.auditHead.upsert({ where: { ownerId: input.ownerId }, create: { ownerId: input.ownerId, version: 1 }, update: { version: { increment: 1 } } })
  const head = await transaction.auditHead.findUniqueOrThrow({ where: { ownerId: input.ownerId } })
  const { currentKeyId } = integrityKeyring()
  const unsigned = {
    id: randomUUID(), ownerId: input.ownerId, actorId: input.actorId, occurredAt: occurredAt.toISOString(),
    action: input.action, reason: input.reason.trim(), objectType: input.objectType, objectId: input.objectId,
    semanticDelta: { fields: changedFields(before, after), ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) },
    previousHash: head.headHash,
    integrityKeyId: currentKeyId,
  }
  const hash = createHmac('sha256', integritySecret(currentKeyId)).update(canonical(unsigned)).digest('hex')
  const event = await transaction.auditEvent.create({ data: { ...unsigned, occurredAt, semanticDelta: JSON.stringify(unsigned.semanticDelta), previousHash: unsigned.previousHash, hash } })
  await transaction.auditHead.update({ where: { ownerId: input.ownerId }, data: { headHash: hash } })
  return event
}

export function verifyAuditChain(events: Array<{ id: string; ownerId: string; actorId: string; occurredAt: Date; action: string; reason: string; objectType: string; objectId: string; semanticDelta: string; previousHash: string | null; hash: string; integrityKeyId?: string }>, head: { headHash: string | null; legacyHeadHash?: string | null; legacyEventCount?: number; version: number } | null): boolean {
  try {
    if (!events.length) return !head || (head.headHash === null && head.version === 0)
    if (!head || head.version !== events.length) return false
    // This runtime is the first persistent writer for AuditEvent. The migration
    // fails closed if it encounters pre-HMAC rows, so every persisted event must
    // verify with the configured integrity key. Legacy head fields are retained
    // only for schema compatibility and must remain empty.
    if ((head.legacyEventCount ?? 0) !== 0 || head.legacyHeadHash) return false
    const byPrevious = new Map<string | null, typeof events>()
    for (const event of events) byPrevious.set(event.previousHash, [...(byPrevious.get(event.previousHash) ?? []), event])
    let previousHash: string | null = null
    for (let index = 0; index < events.length; index++) {
      const candidates: Array<(typeof events)[number]> = byPrevious.get(previousHash) ?? []
      if (candidates.length !== 1) return false
      const event: (typeof events)[number] = candidates[0]
      const integrityKeyId = event.integrityKeyId ?? 'default'
      const unsigned = { id: event.id, ownerId: event.ownerId, actorId: event.actorId, occurredAt: event.occurredAt.toISOString(), action: event.action, reason: event.reason, objectType: event.objectType, objectId: event.objectId, semanticDelta: JSON.parse(event.semanticDelta), previousHash: event.previousHash, integrityKeyId }
      const hash = createHmac('sha256', integritySecret(integrityKeyId)).update(canonical(unsigned)).digest('hex')
      if (hash !== event.hash) return false
      previousHash = event.hash
    }
    return !byPrevious.has(previousHash) && previousHash === head.headHash
  } catch { return false }
}
