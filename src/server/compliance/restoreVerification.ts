import 'server-only'

import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { getDocumentStorage } from '@/server/storage'
import { verifyAuditChain } from './auditPersistence'
import { sha256 } from './retention'
import { registeredStorageReferences, tenantBackupCollections, tenantBackupRegistry, tenantBackupSingletons, type TenantBackupDefinition } from './tenantBackupRegistry'

export type TenantBackupSnapshot = Record<string, any> & { ownerId: string; schemaVersion: number; audit: any[]; auditHead: { headHash: string | null; version: number } | null }

export function excludeBackupPayloadLocators<T extends { payloadStorageKey?: string | null; status?: string }>(manifests: T[]): T[] {
  return manifests.map(manifest => ({ ...manifest, payloadStorageKey: null, status: 'PAYLOAD_EXCLUDED' }))
}

const snapshotTables: Array<[string, string]> = [
  ['settings', 'AccountRecord'],
  ['profiles', 'CompanyProfileVersion'],
  ['profileAddressConfirmations', 'CompanyProfileAddressConfirmation'],
  ['periods', 'FiscalYear'],
  ['accounts', 'LedgerAccount'],
  ['mappings', 'AccountMappingVersion'],
  ['documents', 'DocumentRecord'],
  ['storageClaims', 'DocumentStorageClaim'],
  ['artifacts', 'RetainedArtifact'],
  ['eBalanceSubmissions', 'EBalanceSubmission'],
  ['drafts', 'JournalDraft'],
  ['reopenRequests', 'PeriodReopenRequest'],
  ['amendments', 'FilingAmendment'],
  ['fixityChecks', 'FixityCheck'],
  ['backupManifests', 'BackupManifest'],
  ['audit', 'AuditEvent'],
]

function migratedDatabase() {
  const database = new DatabaseSync(':memory:')
  const migrationsRoot = resolve(process.cwd(), 'prisma', 'migrations')
  for (const directory of readdirSync(migrationsRoot, { withFileTypes: true }).filter(entry => entry.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
    database.exec(readFileSync(join(migrationsRoot, directory.name, 'migration.sql'), 'utf8'))
  }
  database.exec('PRAGMA foreign_keys = ON')
  return database
}

function insertSnapshotRow(database: DatabaseSync, table: string, row: Record<string, unknown>) {
  const available = new Set((database.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(column => column.name))
  const entries = Object.entries(row).filter(([name, value]) => available.has(name) && value !== undefined && !Array.isArray(value) && (value === null || typeof value !== 'object' || value instanceof Uint8Array))
  if (!entries.length) throw new Error(`Backup row for ${table} has no restorable columns`)
  const columns = entries.map(([name]) => `"${name}"`).join(', ')
  const values = entries.map(([, value]) => typeof value === 'boolean' ? Number(value) : value as string | number | bigint | null | Uint8Array)
  database.prepare(`INSERT INTO "${table}" (${columns}) VALUES (${entries.map(() => '?').join(', ')})`).run(...values)
}

function decodedRow(definition: TenantBackupDefinition, row: Record<string, any>) {
  return Object.fromEntries(Object.entries(row).map(([field, value]) => [
    field,
    definition.binaryFields?.includes(field) && typeof value === 'string' ? Buffer.from(value, 'base64') : value,
  ]))
}

function parentFirst(rows: any[], referenceField: string) {
  const pending = new Map(rows.map(row => [row.id, row]))
  const result: any[] = []
  while (pending.size) {
    const ready = [...pending.values()].filter(row => !row[referenceField] || !pending.has(row[referenceField]))
    if (!ready.length) throw new Error(`Backup contains a cyclic ${referenceField} history`)
    ready.sort((left, right) => String(left.id).localeCompare(String(right.id)))
    for (const row of ready) { pending.delete(row.id); result.push(row) }
  }
  return result
}

function verifyCompleteRegisteredSnapshot(snapshot: TenantBackupSnapshot) {
  for (const definition of tenantBackupCollections) {
    const rows = snapshot[definition.snapshotKey]
    if (!Array.isArray(rows)) throw new Error(`Backup collection ${definition.snapshotKey} is missing`)
    if (rows.some((row: any) => row.ownerId !== snapshot.ownerId)) throw new Error(`Backup collection ${definition.snapshotKey} crosses tenant scope`)
  }
  for (const definition of tenantBackupSingletons) {
    const row = snapshot[definition.snapshotKey]
    if (row && row.ownerId !== snapshot.ownerId) throw new Error(`Backup singleton ${definition.snapshotKey} crosses tenant scope`)
  }
  const auditEvents = snapshot.audit.map((event: any) => ({ ...event, occurredAt: new Date(event.occurredAt) }))
  if (!verifyAuditChain(auditEvents, snapshot.auditHead)) throw new Error('Restored audit chain does not match its durable head')

  const database = migratedDatabase()
  try {
    for (const definition of [...tenantBackupRegistry].sort((left, right) => left.order - right.order)) {
      const value = snapshot[definition.snapshotKey]
      if (definition.shape === 'singleton') {
        if (value) insertSnapshotRow(database, definition.table, decodedRow(definition, value))
        continue
      }
      let rows = value as any[]
      if (definition.model === 'CommercialDocument') rows = parentFirst(rows, 'correctsId')
      if (definition.model === 'BankTransactionMatch') rows = parentFirst(rows, 'reversesMatchId')
      if (definition.mode === 'journalGraph') {
        for (const entry of rows) {
          insertSnapshotRow(database, definition.table, decodedRow(definition, entry))
          for (const line of entry.lines ?? []) insertSnapshotRow(database, 'JournalLine', { ...line, journalEntryId: entry.id })
          for (const attachment of entry.documents ?? []) insertSnapshotRow(database, 'JournalDocumentAttachment', { ...attachment, journalEntryId: entry.id })
        }
        continue
      }
      if (definition.mode === 'derivedOpenItem') rows = rows.map(row => ({ ...row, allocatedAmountCents: 0, status: 'OPEN', version: 1 }))
      if (definition.mode === 'derivedSettlement') rows = rows.map(row => ({ ...row, allocatedAmountCents: 0, status: 'UNALLOCATED', version: 1 }))
      if (definition.mode === 'allocationReplay') rows = parentFirst(rows, 'reversesAllocationId').sort((left, right) => {
        const time = new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
        return time || (left.kind === right.kind ? String(left.id).localeCompare(String(right.id)) : left.kind === 'APPLY' ? -1 : 1)
      })
      if (definition.mode === 'membership') for (const row of rows) {
        const userId = String(row.userId)
        const existing = database.prepare('SELECT 1 FROM "user" WHERE "id" = ?').get(userId)
        if (!existing) insertSnapshotRow(database, 'user', {
          id: userId,
          name: 'Isolated restore membership principal',
          email: `${sha256(userId).slice(0, 32)}@restore.invalid`,
          emailVerified: false,
          updatedAt: new Date(0).toISOString(),
        })
      }
      for (const row of rows) insertSnapshotRow(database, definition.table, decodedRow(definition, row))
    }
    for (const expected of snapshot.openItems) {
      const actual = database.prepare('SELECT "allocatedAmountCents", "status", "version" FROM "OpenItem" WHERE "ownerId" = ? AND "id" = ?').get(snapshot.ownerId, expected.id) as any
      if (!actual || actual.allocatedAmountCents !== expected.allocatedAmountCents || actual.status !== expected.status || actual.version !== expected.version) throw new Error(`Restored open item ${expected.id} does not match its allocation history`)
    }
    for (const expected of snapshot.paymentSettlements) {
      const actual = database.prepare('SELECT "allocatedAmountCents", "status", "version" FROM "PaymentSettlement" WHERE "ownerId" = ? AND "id" = ?').get(snapshot.ownerId, expected.id) as any
      if (!actual || actual.allocatedAmountCents !== expected.allocatedAmountCents || actual.status !== expected.status || actual.version !== expected.version) throw new Error(`Restored payment settlement ${expected.id} does not match its allocation history`)
    }
    const integrity = database.prepare('PRAGMA foreign_key_check').all()
    if (integrity.length) throw new Error('Restored tenant snapshot violates referential integrity')
    return {
      periods: snapshot.periods.length, entries: snapshot.entries.length, documents: snapshot.documents.length,
      eBalanceSubmissions: snapshot.eBalanceSubmissions.length, structuredInvoices: snapshot.structuredInvoices.length,
      businessPartners: snapshot.businessPartners.length, commercialDocuments: snapshot.commercialDocuments.length,
      openItems: snapshot.openItems.length, paymentSettlements: snapshot.paymentSettlements.length,
      settlementAllocations: snapshot.settlementAllocations.length,
      invoiceNumberControls: snapshot.invoiceNumberSequences.length + snapshot.invoiceNumberOnboarding.length + snapshot.invoiceNumberReservations.length + snapshot.invoiceIssuanceRequests.length,
      documentExtractions: snapshot.documentExtractions.length, bankAccounts: snapshot.bankAccounts.length,
      bankStatements: snapshot.bankStatements.length, bankTransactions: snapshot.bankTransactions.length,
      bankTransactionMatches: snapshot.bankTransactionMatches.length,
      receivablesReminders: snapshot.receivablesReminders.length,
      receivablesReminderDeliveryAttempts: snapshot.receivablesReminderDeliveryAttempts.length,
      receivablesReminderDeliveryResults: snapshot.receivablesReminderDeliveryResults.length,
      receivablesReminderCancellations: snapshot.receivablesReminderCancellations.length,
      fixedAssets: snapshot.fixedAssets.length, assetEvents: snapshot.assetEvents.length,
      vatPostings: snapshot.vatPostings.length, taxWorkflows: snapshot.taxWorkflows.length,
      registeredCollections: tenantBackupRegistry.length,
    }
  } finally { database.close() }
}

export function verifySnapshotInIsolatedDatabase(snapshot: TenantBackupSnapshot) {
  if (![1, 2, 3, 4].includes(snapshot.schemaVersion) || typeof snapshot.ownerId !== 'string' || !snapshot.ownerId) throw new Error('Unsupported tenant backup schema')
  if (snapshot.schemaVersion === 4) return verifyCompleteRegisteredSnapshot(snapshot)
  if ([2, 3].includes(snapshot.schemaVersion)) {
    const compatible: TenantBackupSnapshot = { ...snapshot, schemaVersion: 4 }
    for (const definition of tenantBackupRegistry) if (compatible[definition.snapshotKey] === undefined) compatible[definition.snapshotKey] = definition.shape === 'singleton' ? null : []
    return verifyCompleteRegisteredSnapshot(compatible)
  }
  const ownedCollections = ['settings', 'profiles', 'profileAddressConfirmations', 'periods', 'accounts', 'mappings', 'documents', 'artifacts', 'audit', 'drafts', 'reopenRequests', 'amendments', 'eBalanceSubmissions', 'fixityChecks', 'storageClaims', 'backupManifests']
  for (const name of ownedCollections) {
    if (!Array.isArray(snapshot[name])) throw new Error(`Backup collection ${name} is missing`)
    if (snapshot[name].some((row: any) => row.ownerId !== snapshot.ownerId)) throw new Error(`Backup collection ${name} crosses tenant scope`)
  }
  if (!Array.isArray(snapshot.entries)) throw new Error('Backup collection entries is missing')
  if (snapshot.entries.some((row: any) => row.ownerId !== snapshot.ownerId)) throw new Error('Backup collection entries crosses tenant scope')
  for (const singleton of ['ledgerProfile', 'policy', 'auditHead']) if (snapshot[singleton] && snapshot[singleton].ownerId !== snapshot.ownerId) throw new Error(`Backup singleton ${singleton} crosses tenant scope`)
  const auditEvents = snapshot.audit.map((event: any) => ({ ...event, occurredAt: new Date(event.occurredAt) }))
  if (!verifyAuditChain(auditEvents, snapshot.auditHead)) throw new Error('Restored audit chain does not match its durable head')

  const database = migratedDatabase()
  try {
    for (const [name, table] of snapshotTables) for (const row of snapshot[name]) insertSnapshotRow(database, table, row)
    if (snapshot.ledgerProfile) insertSnapshotRow(database, 'LedgerProfile', snapshot.ledgerProfile)
    if (snapshot.policy) insertSnapshotRow(database, 'CompliancePolicy', snapshot.policy)
    for (const entry of snapshot.entries as any[]) {
      insertSnapshotRow(database, 'JournalEntry', entry)
      for (const line of entry.lines ?? []) insertSnapshotRow(database, 'JournalLine', { ...line, journalEntryId: entry.id })
      for (const attachment of entry.documents ?? []) insertSnapshotRow(database, 'JournalDocumentAttachment', { ...attachment, journalEntryId: entry.id })
    }
    if (snapshot.auditHead) insertSnapshotRow(database, 'AuditHead', snapshot.auditHead)
    const integrity = database.prepare('PRAGMA foreign_key_check').all()
    if (integrity.length) throw new Error('Restored tenant snapshot violates referential integrity')
    return { periods: snapshot.periods.length, entries: snapshot.entries.length, documents: snapshot.documents.length, eBalanceSubmissions: snapshot.eBalanceSubmissions.length }
  } finally { database.close() }
}

export function verifyRestoredArtifactObjects(artifacts: Array<{ storageKey?: string | null; storageDeletedAt?: unknown; contentHash: string }>, objects: Record<string, Buffer>) {
  return verifyRestoredStorageObjects(artifacts, objects)
}

export function snapshotStorageReferences(snapshot: TenantBackupSnapshot): string[] {
  const references = new Set<string>(snapshot.schemaVersion >= 2 ? registeredStorageReferences(snapshot) : [])
  const add = (value: unknown) => { if (typeof value === 'string' && value) references.add(value) }
  for (const artifact of snapshot.artifacts) if (artifact.storageKey && !artifact.storageDeletedAt) add(artifact.storageKey)
  for (const claim of snapshot.storageClaims) add(claim.storageKey)
  for (const request of snapshot.invoiceIssuanceRequests ?? []) add(request.storageKey)
  const documentArtifacts = new Map<string, any[]>()
  for (const artifact of snapshot.artifacts) if (artifact.objectType === 'Document') documentArtifacts.set(artifact.objectId, [...(documentArtifacts.get(artifact.objectId) ?? []), artifact])
  for (const document of snapshot.documents) {
    const lifecycle = documentArtifacts.get(document.id) ?? []
    if (lifecycle.length && !lifecycle.some(artifact => !artifact.disposedAt && !artifact.storageDeletedAt)) continue
    let payload: Record<string, unknown>
    try { payload = JSON.parse(document.payload) as Record<string, unknown> }
    catch { throw new Error(`Document ${document.id} has an invalid persisted payload`) }
    add(payload.storageKey)
    add(payload.thumbnailStorageKey)
  }
  return [...references].sort()
}

export function verifyRestoredStorageObjects(artifacts: Array<{ storageKey?: string | null; storageDeletedAt?: unknown; contentHash: string }>, objects: Record<string, Buffer>, requiredStorageKeys?: string[]) {
  const expected = new Map<string, string>()
  for (const artifact of artifacts) if (artifact.storageKey && !artifact.storageDeletedAt) {
    const prior = expected.get(artifact.storageKey)
    if (prior && prior !== artifact.contentHash) throw new Error(`Conflicting retained hashes exist for ${artifact.storageKey}`)
    expected.set(artifact.storageKey, artifact.contentHash)
  }
  const required = requiredStorageKeys ? [...new Set(requiredStorageKeys)].sort() : [...expected.keys()].sort()
  if (JSON.stringify(required) !== JSON.stringify(Object.keys(objects).sort())) throw new Error('Restored object set does not match live storage references')
  for (const [storageKey, content] of Object.entries(objects)) {
    const expectedHash = expected.get(storageKey)
    if (expectedHash && sha256(content) !== expectedHash) throw new Error(`Restored object failed retained-artifact fixity verification: ${storageKey}`)
  }
  return { objectCount: objects ? Object.keys(objects).length : 0 }
}

export async function exerciseIsolatedObjectRestore(ownerId: string, backupId: string, objects: Record<string, Buffer>) {
  const storage = getDocumentStorage()
  const keys: string[] = []
  const exerciseId = randomUUID()
  try {
    for (const [originalKey, content] of Object.entries(objects)) {
      const key = `restore-verification/${encodeURIComponent(ownerId)}/${encodeURIComponent(backupId)}/${exerciseId}/${encodeURIComponent(originalKey)}`
      keys.push(key)
      await storage.write(key, content, { contentType: 'application/octet-stream', fileName: 'restored-object.bin' })
      const reread = await storage.read(key)
      if (sha256(reread) !== sha256(content)) throw new Error(`Restored object failed fixity verification: ${originalKey}`)
    }
    return { objectCount: keys.length }
  } finally {
    const cleanup = await Promise.allSettled(keys.map(async key => {
      await storage.delete(key)
      if (await storage.exists(key)) throw new Error(`Isolated restore object still exists after cleanup: ${key}`)
    }))
    const failures = cleanup.filter(result => result.status === 'rejected')
    if (failures.length) throw new Error(`Isolated restore cleanup failed for ${failures.length} object(s)`)
  }
}
