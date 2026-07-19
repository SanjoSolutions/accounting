import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

export type RetentionClass = 'JOURNAL' | 'TAX_RECORD' | 'INVOICE' | 'COMMERCIAL_LETTER' | 'OTHER'
const years: Record<RetentionClass, number> = { JOURNAL: 10, TAX_RECORD: 10, INVOICE: 8, COMMERCIAL_LETTER: 6, OTHER: 6 }
const isRealIsoDate = (value: string) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value }
export const sha256 = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex')
export function retentionDeadline(retentionClass: RetentionClass, periodEndsAt: string, extensions: string[] = []): { retainUntil: string; explanation: string } {
  if (!isRealIsoDate(periodEndsAt) || extensions.some(value => !isRealIsoDate(value))) throw new Error('Retention dates must be real ISO dates')
  const periodEnd = new Date(`${periodEndsAt}T00:00:00.000Z`)
  const base = new Date(Date.UTC(periodEnd.getUTCFullYear() + years[retentionClass], 11, 31))
  const candidates = extensions.map(value => new Date(`${value}T00:00:00.000Z`))
  const deadline = candidates.reduce((latest, date) => date > latest ? date : latest, base)
  return { retainUntil: deadline.toISOString().slice(0, 10), explanation: `${years[retentionClass]}-year ${retentionClass} minimum from calendar-year end${deadline > base ? '; extended by audit/dispute/legal hold' : ''}` }
}

export interface ArtifactVersion { ownerId: string; objectId: string; version: number; retentionClass: RetentionClass; periodEndsAt: string; retainUntil: string; contentHash: string; provenance: string; content: Uint8Array; legalHoldUntil?: string; disposedAt?: string }
export class RetentionRegistry {
  readonly #versions: ArtifactVersion[] = []
  readonly #disposed = new Map<string, string>()
  #key(artifact: ArtifactVersion) { return `${artifact.ownerId}\0${artifact.objectId}\0${artifact.version}` }
  preserve(input: Omit<ArtifactVersion, 'version' | 'retainUntil' | 'contentHash'>): ArtifactVersion {
    if (!input.provenance.trim()) throw new Error('Artifact provenance is required')
    const prior = this.#versions.filter(item => item.ownerId === input.ownerId && item.objectId === input.objectId)
    const artifact = Object.freeze({ ...structuredClone(input), version: prior.length + 1, contentHash: sha256(input.content), retainUntil: retentionDeadline(input.retentionClass, input.periodEndsAt, input.legalHoldUntil ? [input.legalHoldUntil] : []).retainUntil })
    this.#versions.push(artifact); return structuredClone(artifact)
  }
  verify(artifact: ArtifactVersion, content: Uint8Array) {
    const canonical = this.#versions.find(item => item.ownerId === artifact.ownerId && item.objectId === artifact.objectId && item.version === artifact.version)
    return Boolean(canonical && !this.#disposed.has(this.#key(canonical)) && canonical.contentHash === sha256(content))
  }
  dispose(artifact: ArtifactVersion, onDate: string): ArtifactVersion {
    if (!isRealIsoDate(onDate)) throw new Error('Disposal date must be a real ISO date')
    const canonical = this.#versions.find(item => item.ownerId === artifact.ownerId && item.objectId === artifact.objectId && item.version === artifact.version)
    if (!canonical || canonical.contentHash !== artifact.contentHash) throw new Error('Artifact is not the canonical registered version')
    const alreadyDisposedAt = this.#disposed.get(this.#key(canonical))
    if (alreadyDisposedAt) {
      if (alreadyDisposedAt !== onDate) throw new Error(`Artifact was already disposed on ${alreadyDisposedAt}`)
      return { ...structuredClone(canonical), content: new Uint8Array(), disposedAt: alreadyDisposedAt }
    }
    const until = canonical.legalHoldUntil && canonical.legalHoldUntil > canonical.retainUntil ? canonical.legalHoldUntil : canonical.retainUntil
    if (onDate <= until) throw new Error('Artifact is still retained or under legal hold')
    canonical.content.fill(0)
    this.#disposed.set(this.#key(canonical), onDate)
    return { ...structuredClone(canonical), content: new Uint8Array(), disposedAt: onDate }
  }
  versions(ownerId: string, objectId: string) { return this.#versions.filter(item => item.ownerId === ownerId && item.objectId === objectId).map(item => { const disposedAt = this.#disposed.get(this.#key(item)); return { ...structuredClone(item), ...(disposedAt ? { disposedAt, content: new Uint8Array() } : {}) } }) }
}

export interface BackupInput { backupId: string; ownerId: string; database: Uint8Array; objects: Record<string, Uint8Array>; recoveryPointAt: string; region: string; keyId: string }
export interface EncryptedBackup { backupId: string; ownerId: string; recoveryPointAt: string; region: string; keyId: string; databaseHash: string; objectsHash: string; iv: string; tag: string; encrypted: string }
const backupMetadata = (backup: Omit<EncryptedBackup, 'iv' | 'tag' | 'encrypted'>) => JSON.stringify(backup)
export function createBackup(input: BackupInput, key: Uint8Array, allowedRegions: string[]): EncryptedBackup {
  if (key.length !== 32) throw new Error('Backup encryption key must be 256 bit')
  if (!allowedRegions.includes(input.region)) throw new Error('Storage region is outside the approved jurisdiction')
  const objects = Object.fromEntries(Object.entries(input.objects).sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => [name, Buffer.from(data).toString('base64')]))
  const payload = JSON.stringify({ database: Buffer.from(input.database).toString('base64'), objects })
  const metadata = { backupId: input.backupId, ownerId: input.ownerId, recoveryPointAt: input.recoveryPointAt, region: input.region, keyId: input.keyId, databaseHash: sha256(input.database), objectsHash: sha256(JSON.stringify(objects)) }
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(backupMetadata(metadata))); const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  return { ...metadata, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), encrypted: encrypted.toString('base64') }
}
export function resolveBackupKey(keyId: string, env: Readonly<Record<string, string | undefined>> = process.env): Buffer {
  let encoded: string | undefined
  if (env.COMPLIANCE_BACKUP_KEYS_BASE64) {
    const parsed: unknown = JSON.parse(env.COMPLIANCE_BACKUP_KEYS_BASE64)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.values(parsed).some(value => typeof value !== 'string')) throw new Error('COMPLIANCE_BACKUP_KEYS_BASE64 must be a JSON object of base64 keys')
    encoded = (parsed as Record<string, string>)[keyId]
  }
  if (!encoded && env.COMPLIANCE_BACKUP_KEY_ID === keyId) encoded = env.COMPLIANCE_BACKUP_KEY_BASE64
  if (!encoded) throw new Error(`No backup encryption key is configured for key ID ${keyId}`)
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw new Error(`Backup encryption key ${keyId} must encode 256 bits`)
  return key
}
export function backupMatchesManifest(backup: EncryptedBackup, manifest: { id: string; ownerId: string; databaseHash: string; objectStoreHash: string; encryptionKeyId: string; storageRegion: string; recoveryPointAt: Date }): boolean {
  return backup.backupId === manifest.id && backup.ownerId === manifest.ownerId && backup.databaseHash === manifest.databaseHash && backup.objectsHash === manifest.objectStoreHash && backup.keyId === manifest.encryptionKeyId && backup.region === manifest.storageRegion && Number.isFinite(new Date(backup.recoveryPointAt).getTime()) && new Date(backup.recoveryPointAt).getTime() === manifest.recoveryPointAt.getTime()
}
export function restoreBackup(backup: EncryptedBackup, key: Uint8Array): { database: Buffer; objects: Record<string, Buffer>; verifiedAt: string } {
  const { iv, tag, encrypted, ...metadata } = backup
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64')); decipher.setAAD(Buffer.from(backupMetadata(metadata))); decipher.setAuthTag(Buffer.from(tag, 'base64'))
  const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]).toString()) as { database: string; objects: Record<string, string> }
  const database = Buffer.from(parsed.database, 'base64'); if (sha256(database) !== backup.databaseHash) throw new Error('Database backup failed fixity verification')
  if (sha256(JSON.stringify(parsed.objects)) !== backup.objectsHash) throw new Error('Object backup failed fixity verification')
  return { database, objects: Object.fromEntries(Object.entries(parsed.objects).map(([name, data]) => [name, Buffer.from(data, 'base64')])), verifiedAt: new Date().toISOString() }
}
export function assertRecoveryObjectives(latestRecoveryPoint: string, now: string, rpoMinutes: number, measuredRestoreMinutes: number, rtoMinutes: number) {
  const recoveryTime = Date.parse(latestRecoveryPoint); const nowTime = Date.parse(now)
  if (![recoveryTime, nowTime, rpoMinutes, measuredRestoreMinutes, rtoMinutes].every(Number.isFinite) || rpoMinutes < 0 || measuredRestoreMinutes < 0 || rtoMinutes < 0) throw new Error('Recovery objective inputs are invalid')
  if (recoveryTime > nowTime) throw new Error('Recovery point cannot be in the future')
  if ((nowTime - recoveryTime) / 60_000 > rpoMinutes) throw new Error('RPO exceeded')
  if (measuredRestoreMinutes > rtoMinutes) throw new Error('RTO exceeded')
}
