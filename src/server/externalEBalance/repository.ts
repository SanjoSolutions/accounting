import 'server-only'

import { randomUUID } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import type { Prisma } from '@/generated/prisma/client'
import { canonicalJson } from '@/core/compliance/auditExport'
import { retentionDeadline } from '@/server/compliance/retention'
import { appendAuditEvent } from '@/server/compliance/auditPersistence'
import type { DocumentStorage } from '@/server/storage/DocumentStorage'
import { createExternalPackage, hashBytes, readExternalPackage, type ExternalEBalanceSource } from './adapter'

export class ExternalExportError extends Error {
  constructor(message: string, public status = 409) { super(message) }
}
type Client = Prisma.TransactionClient
type Database = Client & { $transaction<T>(work: (tx: Client) => Promise<T>, options?: { timeout?: number }): Promise<T> }
type Dependencies = {
  database: Database; storage: () => DocumentStorage
  prepare: (ownerId: string, fiscalYearId: string, client?: Client) => Promise<ExternalEBalanceSource>
  audit?: typeof appendAuditEvent
}
const PACKAGE = 'ExternalEBalancePackage'
const EVIDENCE = 'ExternalEBalanceEvidence'
export const MAX_EXTERNAL_EVIDENCE_BYTES = 5 * 1024 * 1024
export type ExternalEvidenceInput = {
  packageHash: string; kind: string; provider: string; occurredAt: string; note: string
  confirmSource: boolean; fileName: string; bytes: Uint8Array
}

export function validateExternalEvidence(input: ExternalEvidenceInput) {
  if (!['VALIDATION', 'TRANSMISSION', 'ACCEPTANCE_CLAIM'].includes(input.kind)) throw new ExternalExportError('Ungültige Nachweisart.', 400)
  if (!/^[a-f0-9]{64}$/.test(input.packageHash) || input.confirmSource !== true) throw new ExternalExportError('Die genaue Exportversion muss ausdrücklich bestätigt werden.', 400)
  for (const [value, limit] of [[input.provider, 120], [input.note, 2000], [input.fileName, 200]] as const) {
    if (!value.trim() || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new ExternalExportError('Anbieter, Erläuterung und Dateiname sind erforderlich und müssen gültig sein.', 400)
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(input.occurredAt) || !Number.isFinite(Date.parse(input.occurredAt)) || new Date(input.occurredAt).toISOString().slice(0, 19) !== input.occurredAt.slice(0, 19) || Date.parse(input.occurredAt) > Date.now()) throw new ExternalExportError('Ein gültiger, nicht zukünftiger Nachweiszeitpunkt ist erforderlich.', 400)
  if (!input.bytes.byteLength || input.bytes.byteLength > MAX_EXTERNAL_EVIDENCE_BYTES) throw new ExternalExportError('Der Nachweis muss zwischen 1 Byte und 5 MiB groß sein.', 400)
}

export function createExternalEBalanceRepository({ database, storage, prepare, audit = appendAuditEvent }: Dependencies) {
  async function period(ownerId: string, year: number, client: Client = database) {
    const result = await client.fiscalYear.findFirst({ where: { ownerId, year } })
    if (!result) throw new ExternalExportError('Geschäftsjahr nicht gefunden.', 404)
    return result
  }
  async function load(ownerId: string, year: number, id: string) {
    const fiscalYear = await period(ownerId, year)
    const artifact = await database.retainedArtifact.findFirst({ where: { id, ownerId, objectType: PACKAGE, objectId: fiscalYear.id, disposedAt: null, storageDeletedAt: null } })
    if (!artifact?.storageKey) throw new ExternalExportError('Exportversion nicht gefunden.', 404)
    const content = await storage().read(artifact.storageKey)
    const parsed = readExternalPackage(content, artifact.contentHash)
    if (parsed.manifest.version !== artifact.version || parsed.manifest.fiscalYearId !== fiscalYear.id || parsed.manifest.year !== year) throw new ExternalExportError('Exportversion und Manifest stimmen nicht überein.')
    return { artifact, content, ...parsed }
  }
  async function sourceState(ownerId: string, fiscalYearId: string) {
    try { return { source: await prepare(ownerId, fiscalYearId), issues: [] as string[] } }
    catch (error) { return { source: null, issues: [error instanceof Error ? error.message : 'Exportdaten sind nicht bereit.'] } }
  }
  const status = (source: ExternalEBalanceSource | null, fingerprint: string) => source?.sourceFingerprint === fingerprint ? 'CURRENT' as const : 'STALE' as const

  return {
    async overview(ownerId: string, year: number) {
      const fiscalYear = await period(ownerId, year)
      const [state, rows] = await Promise.all([
        sourceState(ownerId, fiscalYear.id),
        database.retainedArtifact.findMany({ where: { ownerId, objectType: PACKAGE, objectId: fiscalYear.id, disposedAt: null, storageDeletedAt: null }, orderBy: { version: 'desc' }, take: 50 }),
      ])
      const packages = await Promise.all(rows.map(async artifact => {
        const { manifest } = await load(ownerId, year, artifact.id)
        const evidence = await database.retainedArtifact.findMany({ where: { ownerId, objectType: EVIDENCE, objectId: artifact.id, disposedAt: null, storageDeletedAt: null }, orderBy: { version: 'desc' } })
        return { id: artifact.id, version: artifact.version, contentHash: artifact.contentHash, createdAt: artifact.createdAt.toISOString(), sourceStatus: status(state.source, manifest.sourceFingerprint), manifest, evidence: evidence.map(row => ({ id: row.id, ...JSON.parse(row.provenance), contentHash: row.contentHash })) }
      }))
      let issues = state.issues
      if (state.source) {
        try { createExternalPackage(state.source, 1) }
        catch (error) { issues = [error instanceof Error ? error.message : 'Adapter nicht bereit.'] }
      }
      return { ready: issues.length === 0, issues, packages }
    },
    async create(ownerId: string, actorId: string, year: number) {
      const fiscalYear = await period(ownerId, year)
      const source = await prepare(ownerId, fiscalYear.id)
      let stagedKey: string | undefined
      try {
        return await database.$transaction(async tx => {
          // Re-read through the shared authoritative provider in the write transaction.
          // This includes both the current-close gate and reconciliation changes.
          const current = await prepare(ownerId, fiscalYear.id, tx)
          if (current.closeGenerationId !== source.closeGenerationId || current.sourceFingerprint !== source.sourceFingerprint) throw new ExternalExportError('Die Exportgrundlage hat sich geändert. Bitte neu vorbereiten.')
          const latest = await tx.retainedArtifact.findFirst({ where: { ownerId, objectType: PACKAGE, objectId: fiscalYear.id }, orderBy: { version: 'desc' } })
          const version = (latest?.version ?? 0) + 1
          const { archive, manifest } = createExternalPackage(source, version)
          const id = randomUUID(); stagedKey = `tax-exports/${encodeURIComponent(ownerId)}/external-${id}.zip`
          await storage().write(stagedKey, Buffer.from(archive), { contentType: 'application/zip', fileName: `e-bilanz-extern-${year}-v${version}.zip` })
          const deadline = retentionDeadline('TAX_RECORD', source.endsAt)
          const artifact = await tx.retainedArtifact.create({ data: { id, ownerId, objectType: PACKAGE, objectId: fiscalYear.id, version, retentionClass: 'TAX_RECORD', contentHash: hashBytes(archive), provenance: canonicalJson({ adapterVersion: manifest.adapterVersion, closeGenerationId: source.closeGenerationId, sourceFingerprint: source.sourceFingerprint }), storageKey: stagedKey, periodEndsAt: fiscalYear.endsAt, retainUntil: new Date(`${deadline.retainUntil}T23:59:59.999Z`) } })
          await audit(tx, { ownerId, actorId, action: 'EXTERNAL_E_BILANZ_PREPARED', objectType: PACKAGE, objectId: id, reason: 'Exportversion zur externen Prüfung vorbereitet', after: { version, contentHash: artifact.contentHash, closeGenerationId: source.closeGenerationId, sourceFingerprint: source.sourceFingerprint } })
          return { id, version, contentHash: artifact.contentHash }
        }, { timeout: 30_000 })
      } catch (error) {
        if (stagedKey) await storage().delete(stagedKey)
        throw error
      }
    },
    async download(ownerId: string, actorId: string, year: number, id: string, file?: string) {
      const loaded = await load(ownerId, year, id)
      const permitted = ['manifest.json', 'susa.csv', 'myebilanz-salden.csv', 'myebilanz-mapping.ini.template', 'abstimmung.json', 'datengrundlage.json', 'e-bilanz.xbrl', 'ANLEITUNG.txt', 'SHA256SUMS.txt', 'xbrl-mit-taxonomie.zip']
      if (file && !permitted.includes(file)) throw new ExternalExportError('Datei nicht gefunden.', 404)
      const content = file ? loaded.files[file] : loaded.content
      if (!content) throw new ExternalExportError('Diese Datei ist in der gewählten Exportversion nicht enthalten.', 404)
      const state = await sourceState(ownerId, loaded.manifest.fiscalYearId)
      const sourceStatus = status(state.source, loaded.manifest.sourceFingerprint)
      await database.$transaction(tx => audit(tx, { ownerId, actorId, action: 'EXTERNAL_E_BILANZ_DOWNLOADED', objectType: PACKAGE, objectId: id, reason: 'Gespeicherte Exportbytes abgerufen', after: { version: loaded.artifact.version, packageHash: loaded.artifact.contentHash, file: file ?? null, contentHash: hashBytes(content), sourceStatus } }))
      return { content, contentHash: hashBytes(content), packageHash: loaded.artifact.contentHash, fileName: file ?? `e-bilanz-extern-${year}-v${loaded.artifact.version}.zip`, sourceStatus }
    },
    async attachEvidence(ownerId: string, actorId: string, year: number, id: string, input: ExternalEvidenceInput) {
      validateExternalEvidence(input)
      const loaded = await load(ownerId, year, id)
      if (input.packageHash !== loaded.artifact.contentHash) throw new ExternalExportError('Der Nachweis bezieht sich nicht auf diese Exportbytes.')
      const evidenceId = randomUUID()
      const metadata = { trust: 'USER_SUPPLIED_UNAUTHENTICATED', kind: input.kind, provider: input.provider, occurredAt: input.occurredAt, note: input.note, fileName: input.fileName, fileHash: hashBytes(input.bytes), packageId: id, packageVersion: loaded.artifact.version, packageHash: loaded.artifact.contentHash, sourceFingerprint: loaded.manifest.sourceFingerprint, recordedBy: actorId, recordedAt: new Date().toISOString() }
      const content = Buffer.from(zipSync({ 'evidence.json': strToU8(canonicalJson(metadata)), 'receipt.bin': input.bytes }))
      const key = `tax-exports/${encodeURIComponent(ownerId)}/external-evidence-${evidenceId}.zip`
      await storage().write(key, content, { contentType: 'application/zip', fileName: `nachweis-${evidenceId}.zip` })
      try {
        return await database.$transaction(async tx => {
          const parent = await tx.retainedArtifact.findFirst({ where: { id, ownerId, objectType: PACKAGE, contentHash: input.packageHash, disposedAt: null, storageDeletedAt: null } })
          if (!parent) throw new ExternalExportError('Exportversion nicht mehr verfügbar.')
          const latest = await tx.retainedArtifact.findFirst({ where: { ownerId, objectType: EVIDENCE, objectId: id }, orderBy: { version: 'desc' } })
          await tx.retainedArtifact.create({ data: { id: evidenceId, ownerId, objectType: EVIDENCE, objectId: id, version: (latest?.version ?? 0) + 1, retentionClass: 'TAX_RECORD', contentHash: hashBytes(content), provenance: canonicalJson(metadata), storageKey: key, periodEndsAt: parent.periodEndsAt, retainUntil: parent.retainUntil } })
          await audit(tx, { ownerId, actorId, action: 'EXTERNAL_E_BILANZ_EVIDENCE_ATTACHED', objectType: EVIDENCE, objectId: evidenceId, reason: input.note, after: metadata })
          // No EBalanceSubmission/TaxWorkflow update: an upload cannot attest a gateway receipt.
          return { id: evidenceId, ...metadata }
        })
      } catch (error) { await storage().delete(key); throw error }
    },
    async downloadEvidence(ownerId: string, actorId: string, year: number, packageId: string, evidenceId: string) {
      await load(ownerId, year, packageId)
      const row = await database.retainedArtifact.findFirst({ where: { id: evidenceId, ownerId, objectType: EVIDENCE, objectId: packageId, disposedAt: null, storageDeletedAt: null } })
      if (!row?.storageKey) throw new ExternalExportError('Nachweis nicht gefunden.', 404)
      const content = await storage().read(row.storageKey)
      if (hashBytes(content) !== row.contentHash) throw new ExternalExportError('Die Nachweisbytes haben sich verändert.')
      await database.$transaction(tx => audit(tx, { ownerId, actorId, action: 'EXTERNAL_E_BILANZ_EVIDENCE_DOWNLOADED', objectType: EVIDENCE, objectId: evidenceId, reason: 'Gespeicherten Benutzernachweis abgerufen', after: { contentHash: row.contentHash, packageId } }))
      return { content, contentHash: row.contentHash, fileName: `nachweis-${evidenceId}.zip` }
    },
  }
}
