import { describe, expect, it, vi } from 'vitest'
import { appendAuditEvent, verifyAuditChain } from './auditPersistence'

describe('durable append-only audit persistence', () => {
  it('serializes through a per-tenant head and produces a verifiable semantic chain', async () => {
    const heads = new Map<string, { ownerId: string; headHash: string | null; version: number }>()
    const events: any[] = []
    const transaction = {
      auditHead: {
        upsert: vi.fn(async ({ where, create }: any) => { const current = heads.get(where.ownerId); if (current) current.version++; else heads.set(where.ownerId, { ...create, headHash: null }) }),
        findUniqueOrThrow: vi.fn(async ({ where }: any) => heads.get(where.ownerId)),
        update: vi.fn(async ({ where, data }: any) => Object.assign(heads.get(where.ownerId)!, data)),
      },
      auditEvent: { create: vi.fn(async ({ data }: any) => { const event = { ...data, createdAt: data.occurredAt }; events.push(event); return event }) },
    }
    await appendAuditEvent(transaction as never, { ownerId: 'tenant-a', actorId: 'user-a', action: 'SETTINGS_CHANGED', reason: 'approved', objectType: 'Settings', objectId: 's', before: { name: 'Old', unchanged: 1 }, after: { name: 'New', unchanged: 1 }, occurredAt: new Date('2026-01-01T00:00:00Z') })
    await appendAuditEvent(transaction as never, { ownerId: 'tenant-a', actorId: 'user-a', action: 'LOCKED', reason: 'close', objectType: 'Period', objectId: 'p', after: { status: 'CLOSED' }, occurredAt: new Date('2026-01-02T00:00:00Z') })
    expect(JSON.parse(events[0].semanticDelta).fields).toEqual(['name'])
    expect(events[1].previousHash).toBe(events[0].hash)
    expect(verifyAuditChain(events, heads.get('tenant-a')!)).toBe(true)
    expect(transaction.auditHead.upsert).toHaveBeenCalledTimes(2)
  })

  it('detects tampering, missing events and branched tenant history', async () => {
    const base = { id: '1', ownerId: 'a', actorId: 'u', occurredAt: new Date('2026-01-01'), action: 'X', reason: 'r', objectType: 'O', objectId: '1', semanticDelta: '{}', previousHash: null, hash: 'not-valid' }
    expect(verifyAuditChain([base], { headHash: base.hash, version: 1 })).toBe(false)
    expect(verifyAuditChain([{ ...base }, { ...base, id: '2' }], { headHash: base.hash, version: 2 })).toBe(false)
    expect(verifyAuditChain([{ ...base, semanticDelta: '{broken' }], { headHash: base.hash, version: 1 })).toBe(false)
  })

  it('hashes and persists Date-containing semantic deltas in the same normalized representation', async () => {
    const heads = new Map<string, { ownerId: string; headHash: string | null; version: number }>()
    const events: any[] = []
    const transaction = {
      auditHead: {
        upsert: vi.fn(async ({ where, create }: any) => { heads.set(where.ownerId, heads.get(where.ownerId) ?? { ...create, headHash: null }) }),
        findUniqueOrThrow: vi.fn(async ({ where }: any) => heads.get(where.ownerId)),
        update: vi.fn(async ({ where, data }: any) => Object.assign(heads.get(where.ownerId)!, data)),
      },
      auditEvent: { create: vi.fn(async ({ data }: any) => { const event = { ...data, createdAt: data.occurredAt }; events.push(event); return event }) },
    }
    await appendAuditEvent(transaction as never, { ownerId: 'tenant-a', actorId: 'operator-a', action: 'HOLD', reason: 'case', objectType: 'Artifact', objectId: 'a', before: { until: new Date('2030-01-01T00:00:00Z') }, after: { until: new Date('2040-01-01T00:00:00Z') } })
    expect(JSON.parse(events[0].semanticDelta).after.until).toBe('2040-01-01T00:00:00.000Z')
    expect(verifyAuditChain(events, heads.get('tenant-a')!)).toBe(true)
  })

  it('rejects a valid chain prefix when the durable head proves its tail was removed', async () => {
    const heads = new Map<string, { ownerId: string; headHash: string | null; version: number }>()
    const events: any[] = []
    const transaction = {
      auditHead: {
        upsert: vi.fn(async ({ where, create }: any) => { const current = heads.get(where.ownerId); if (current) current.version++; else heads.set(where.ownerId, { ...create, headHash: null }) }),
        findUniqueOrThrow: vi.fn(async ({ where }: any) => heads.get(where.ownerId)),
        update: vi.fn(async ({ where, data }: any) => Object.assign(heads.get(where.ownerId)!, data)),
      },
      auditEvent: { create: vi.fn(async ({ data }: any) => { const event = { ...data, createdAt: data.occurredAt }; events.push(event); return event }) },
    }
    await appendAuditEvent(transaction as never, { ownerId: 'tenant-a', actorId: 'u', action: 'A', reason: 'r', objectType: 'O', objectId: '1' })
    await appendAuditEvent(transaction as never, { ownerId: 'tenant-a', actorId: 'u', action: 'B', reason: 'r', objectType: 'O', objectId: '2' })
    expect(verifyAuditChain(events.slice(0, 1), heads.get('tenant-a')!)).toBe(false)
    expect(verifyAuditChain([], heads.get('tenant-a')!)).toBe(false)
  })
  it('never lets mutable legacy-head metadata exempt unsigned events from HMAC verification', () => {
    const legacy = [
      { id: 'legacy-1', ownerId: 'a', actorId: 'u', occurredAt: new Date('2025-01-01'), action: 'A', reason: 'r', objectType: 'O', objectId: '1', semanticDelta: '{}', previousHash: null, hash: 'legacy-hash-1' },
      { id: 'legacy-2', ownerId: 'a', actorId: 'u', occurredAt: new Date('2025-01-02'), action: 'B', reason: 'r', objectType: 'O', objectId: '2', semanticDelta: '{}', previousHash: 'legacy-hash-1', hash: 'legacy-hash-2' },
    ]
    const head = { headHash: 'legacy-hash-2', legacyHeadHash: 'legacy-hash-2', legacyEventCount: 2, version: 2 }
    expect(verifyAuditChain(legacy, head)).toBe(false)
    expect(verifyAuditChain(legacy.slice(0, 1), head)).toBe(false)
    expect(verifyAuditChain([{ ...legacy[0], hash: 'changed' }, legacy[1]], head)).toBe(false)
  })
  it('verifies a mixed-key chain after integrity-key rotation', async () => {
    const priorKeys = process.env.AUDIT_INTEGRITY_KEYS
    const priorKeyId = process.env.AUDIT_INTEGRITY_KEY_ID
    const heads = new Map<string, { ownerId: string; headHash: string | null; version: number }>()
    const events: any[] = []
    const transaction = {
      auditHead: {
        upsert: vi.fn(async ({ where, create }: any) => { const current = heads.get(where.ownerId); if (current) current.version++; else heads.set(where.ownerId, { ...create, headHash: null }) }),
        findUniqueOrThrow: vi.fn(async ({ where }: any) => heads.get(where.ownerId)),
        update: vi.fn(async ({ where, data }: any) => Object.assign(heads.get(where.ownerId)!, data)),
      },
      auditEvent: { create: vi.fn(async ({ data }: any) => { events.push(data); return data }) },
    }
    try {
      process.env.AUDIT_INTEGRITY_KEYS = JSON.stringify({ old: 'old-audit-integrity-key-32-bytes!', current: 'new-audit-integrity-key-32-bytes!' })
      process.env.AUDIT_INTEGRITY_KEY_ID = 'old'
      await appendAuditEvent(transaction as never, { ownerId: 'tenant', actorId: 'actor', action: 'A', reason: 'first', objectType: 'Object', objectId: '1' })
      process.env.AUDIT_INTEGRITY_KEY_ID = 'current'
      await appendAuditEvent(transaction as never, { ownerId: 'tenant', actorId: 'actor', action: 'B', reason: 'rotated', objectType: 'Object', objectId: '2' })
      expect(events.map(event => event.integrityKeyId)).toEqual(['old', 'current'])
      expect(verifyAuditChain(events, heads.get('tenant')!)).toBe(true)
    } finally {
      if (priorKeys === undefined) delete process.env.AUDIT_INTEGRITY_KEYS; else process.env.AUDIT_INTEGRITY_KEYS = priorKeys
      if (priorKeyId === undefined) delete process.env.AUDIT_INTEGRITY_KEY_ID; else process.env.AUDIT_INTEGRITY_KEY_ID = priorKeyId
    }
  })
})
