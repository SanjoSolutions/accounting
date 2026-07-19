import { createHash } from 'node:crypto'
import { compareCanonicalText } from './deterministicOrder'

export type ExportRow = Readonly<Record<string, unknown> & { tenantId: string }>
export interface AuditExportSource {
  masterData: readonly ExportRow[]; chartMappings: readonly ExportRow[]; fiscalYears: readonly ExportRow[]; journal: readonly ExportRow[]
  journalLines: readonly ExportRow[]; openingClosing: readonly ExportRow[]; vatDetails: readonly ExportRow[]
  evidence: readonly ExportRow[]; auditEvents: readonly ExportRow[]; taxSubmissions: readonly ExportRow[]
  openItems?: readonly ExportRow[]
  cashBooks?: readonly ExportRow[]; cashBookEntries?: readonly ExportRow[]; cashDailyCloses?: readonly ExportRow[]
}
export interface ExportAccess { tenantId: string; actorId: string; authorityReference: string; accessedAt: string; purpose: 'AUDIT' | 'MIGRATION' }
export interface ExportAuditSink { record(event: Readonly<ExportAccess & { action: 'EXPORT_CREATED'; packageChecksum: string }>): void | Promise<void> }
export interface MigrationPackageAuthenticator { keyId: string; sign(payload: string): string; verify(payload: string, signature: string, keyId: string): boolean }
export interface AuditPackage {
  manifest: { format: 'accounting-audit-package'; version: 1; tenantId: string; createdAt: string; purpose: ExportAccess['purpose']; authorityReference: string; files: readonly { path: string; bytes: number; sha256: string; rows?: number }[]; packageChecksum: string }
  files: Readonly<Record<string, string>>
  authenticity?: { keyId: string; signature: string }
}
const DATASETS = ['masterData', 'chartMappings', 'fiscalYears', 'journal', 'journalLines', 'openingClosing', 'vatDetails', 'evidence', 'auditEvents', 'taxSubmissions', 'openItems', 'cashBooks', 'cashBookEntries', 'cashDailyCloses'] as const
const DOCUMENTATION_PATHS = ['documentation/README.txt', 'documentation/schema.json'] as const
const REPORT_PATHS = ['reports/Grundbuch.csv', 'reports/Hauptbuch-Kontenblaetter.csv', 'reports/SuSa.csv', 'reports/statement-drilldown.json', 'reports/open-items.json', 'reports/cash-book.json'] as const
const PRIMARY_KEYS: Record<typeof DATASETS[number], readonly string[]> = { masterData: ['id'], chartMappings: ['accountId'], fiscalYears: ['id'], journal: ['id'], journalLines: ['id'], openingClosing: ['fiscalYearId', 'accountId'], vatDetails: ['id'], evidence: ['id'], auditEvents: ['id'], taxSubmissions: ['id'], openItems: ['id'], cashBooks: ['id'], cashBookEntries: ['cashBookId', 'sequence'], cashDailyCloses: ['bookId', 'businessDate'] }
const SCHEMA_RELATIONSHIPS = [
  'journal.fiscalYearId -> fiscalYears.id',
  'journalLines.journalEntryId -> journal.id', 'journalLines.accountId -> chartMappings.accountId',
  'openingClosing.fiscalYearId -> fiscalYears.id', 'openingClosing.accountId -> chartMappings.accountId',
  'evidence.journalEntryId -> journal.id', 'vatDetails.journalLineId -> journalLines.id', 'vatDetails.submissionId -> taxSubmissions.id',
  'vatDetails linked taxSubmissions.kind = VAT', 'vatDetails.returnPeriod = linked taxSubmissions.returnPeriod', 'vatDetails linked journal fiscalYearId = taxSubmissions.fiscalYearId',
  'taxSubmissions.fiscalYearId -> fiscalYears.id', 'VAT taxSubmissions.returnPeriod within referenced fiscalYears inclusive start/end month',
  'cashBookEntries.cashBookId -> cashBooks.id', 'cashDailyCloses.bookId -> cashBooks.id', 'cashBooks.glAccountId -> chartMappings.accountId',
  'cashBookEntries.journalEntryId -> journal.id with matching tenant, fiscal year, business date, GL account and signed amount',
  'cashDailyCloses.resolutionJournalEntryId -> journal.id with matching tenant, fiscal year, business date, GL account and count-difference amount',
  'cashBookEntries.evidenceIds[] -> evidence.id',
  'cashBookEntries.fiscalYearId -> fiscalYears.id', 'cashBookEntries.businessDate within referenced fiscalYears inclusive start/end date',
  'cashDailyCloses.fiscalYearId -> fiscalYears.id', 'cashDailyCloses.businessDate within referenced fiscalYears inclusive start/end date',
  'cashDailyCloses.entrySequenceThrough = contiguous cashBookEntries.sequence coverage for the same bookId through businessDate',
] as const
const PACKAGE_README = 'Accounting audit/migration package\nEncoding: UTF-8\nFormat: canonical JSON (sorted object keys)\nAmounts: integer cents\nDates: ISO 8601\n'

export async function createAuditPackage(source: AuditExportSource, access: ExportAccess, sink: ExportAuditSink, authenticator?: MigrationPackageAuthenticator): Promise<AuditPackage> {
  const accessSnapshot = captureExportAccess(access)
  if (typeof accessSnapshot.tenantId !== 'string' || !accessSnapshot.tenantId.trim() || accessSnapshot.tenantId !== accessSnapshot.tenantId.trim()) throw new Error('Export tenantId is required in canonical trimmed form.')
  requireIsoInstant(accessSnapshot.accessedAt, 'accessedAt')
  if (accessSnapshot.purpose !== 'AUDIT' && accessSnapshot.purpose !== 'MIGRATION') throw new Error('Export purpose must be AUDIT or MIGRATION.')
  if (typeof accessSnapshot.actorId !== 'string' || typeof accessSnapshot.authorityReference !== 'string' || !accessSnapshot.actorId.trim() || !accessSnapshot.authorityReference.trim()) throw new Error('Actor and authority reference are required.')
  let signingAdapter: { keyId: string; sign: MigrationPackageAuthenticator['sign'] } | undefined
  if (authenticator !== undefined) { if (!isRecord(authenticator)) throw new Error('Migration package authenticator requires a nonblank key ID and signing function.'); const keyId = authenticator.keyId; const sign = authenticator.sign; if (typeof keyId !== 'string' || !keyId.trim() || typeof sign !== 'function') throw new Error('Migration package authenticator requires a nonblank key ID and signing function.'); signingAdapter = { keyId, sign } }
  if (accessSnapshot.purpose === 'MIGRATION' && !signingAdapter) throw new Error('Migration package creation requires a trusted external authenticator.')
  if (!source || typeof source !== 'object') throw new Error('Audit export source must be an object with dataset arrays.')
  const adapterRows = {} as Record<typeof DATASETS[number], readonly ExportRow[]>
  for (const name of DATASETS) {
    const supplied = source[name]
    if (['openItems', 'cashBooks', 'cashBookEntries', 'cashDailyCloses'].includes(name) && supplied === undefined) { adapterRows[name] = []; continue }
    if (!Array.isArray(supplied)) throw new Error(`Audit export dataset ${name} must be an array.`)
    requireDenseArray(supplied)
    const snapshots: ExportRow[] = []
    for (let index = 0; index < supplied.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(supplied, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`Audit export dataset ${name} row ${index} must be an own data property without accessors.`)
      const row = descriptor.value
      if (!isPlainRecord(row)) throw new Error(`Audit export dataset ${name} row ${index} must be a plain object with a nonblank string tenantId.`)
      const snapshot = captureDataRecord(row, `Audit export dataset ${name} row ${index}`)
      if (typeof snapshot === 'string') throw new Error(snapshot)
      if (name === 'cashBookEntries') { const evidenceIds = captureDenseDataArray(snapshot.evidenceIds); if (evidenceIds === null) throw new Error('cashBookEntries require dense nonblank evidenceIds.'); snapshot.evidenceIds = evidenceIds }
      if (name === 'cashBookEntries' && typeof snapshot.externalId === 'string') snapshot.externalId = snapshot.externalId.trim()
      if (!Object.hasOwn(snapshot, 'tenantId') || typeof snapshot.tenantId !== 'string' || !snapshot.tenantId.trim()) throw new Error(`Audit export dataset ${name} row ${index} must be a plain object with a nonblank string tenantId.`)
      if (snapshot.tenantId !== snapshot.tenantId.trim()) throw new Error(`Audit export dataset ${name} row ${index} tenantId must use canonical trimmed form.`)
      snapshots.push(snapshot as ExportRow)
    }
    adapterRows[name] = snapshots
  }
  const scopedSource = Object.fromEntries(DATASETS.map(name => [name, adapterRows[name].filter(row => row.tenantId === accessSnapshot.tenantId)])) as unknown as AuditExportSource
  validateAccountingSchema(scopedSource)
  const normalizedSource = normalizeDatasetOrder(scopedSource)
  const files: Record<string, string> = {}; const counts = {} as Record<typeof DATASETS[number], number>
  for (const name of DATASETS) {
    const rows = normalizedSource[name] ?? []
    counts[name] = rows.length; files[`data/${name}.json`] = canonicalJson(rows)
  }
  Object.assign(files, createDocumentation(counts))
  Object.assign(files, createHumanReadableReports(normalizedSource.fiscalYears as ExportRow[], normalizedSource.journal as ExportRow[], normalizedSource.journalLines as ExportRow[], normalizedSource.chartMappings as ExportRow[], normalizedSource.openingClosing as ExportRow[], (normalizedSource.openItems ?? []) as ExportRow[], (normalizedSource.cashBooks ?? []) as ExportRow[], (normalizedSource.cashBookEntries ?? []) as ExportRow[], (normalizedSource.cashDailyCloses ?? []) as ExportRow[]))
  const manifestFiles = Object.entries(files).sort(([a], [b]) => compareCanonicalText(a, b)).map(([path, contents]) => ({ path, bytes: Buffer.byteLength(contents, 'utf8'), sha256: sha256(contents), ...(path.startsWith('data/') ? { rows: (JSON.parse(contents) as unknown[]).length } : {}) }))
  const checksumInput = { format: 'accounting-audit-package', version: 1, tenantId: accessSnapshot.tenantId, createdAt: accessSnapshot.accessedAt, purpose: accessSnapshot.purpose, authorityReference: accessSnapshot.authorityReference, files: manifestFiles }
  const packageChecksum = sha256(canonicalJson(checksumInput))
  const manifest: AuditPackage['manifest'] = { format: 'accounting-audit-package', version: 1, tenantId: accessSnapshot.tenantId, createdAt: accessSnapshot.accessedAt, purpose: accessSnapshot.purpose, authorityReference: accessSnapshot.authorityReference, files: manifestFiles, packageChecksum }
  let authenticity: AuditPackage['authenticity']
  if (signingAdapter) { const signature = signingAdapter.sign.call(authenticator, authenticityPayload(manifest)); if (typeof signature !== 'string' || !signature.trim()) throw new Error('Migration package authenticator returned a blank or malformed signature.'); authenticity = { keyId: signingAdapter.keyId, signature } }
  const result: AuditPackage = { manifest, files, ...(authenticity ? { authenticity } : {}) }
  await sink.record({ ...accessSnapshot, action: 'EXPORT_CREATED', packageChecksum })
  return result
}

export function verifyAuditPackage(untrustedPackage: unknown): string[] {
  const captured = captureAuditPackage(untrustedPackage)
  return typeof captured === 'string' ? [captured] : verifyAuditPackageSnapshot(captured)
}

function verifyAuditPackageSnapshot(untrustedPackage: CapturedAuditPackage): string[] {
  const errors: string[] = []
  const manifest = ownSnapshot(untrustedPackage.manifest)
  const files = untrustedPackage.files
  if (!Array.isArray(manifest.files)) return ['Manifest files must be an array']
  let entriesAreStructured = true
  const manifestFileSnapshots: Record<string, unknown>[] = []
  for (const [index, rawEntry] of manifest.files.entries()) {
    if (!isPlainRecord(rawEntry)) { errors.push(`Manifest file entry ${index} must be a plain object`); entriesAreStructured = false; continue }
    const entry = ownSnapshot(rawEntry); manifestFileSnapshots.push(entry)
    if (typeof entry.path !== 'string') { errors.push(`Manifest file entry ${index} path must be a string`); entriesAreStructured = false }
    if (!Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0) { errors.push(`Manifest file entry ${index} bytes must be a nonnegative safe integer`); entriesAreStructured = false }
    if (typeof entry.sha256 !== 'string') { errors.push(`Manifest file entry ${index} sha256 must be a string`); entriesAreStructured = false }
    if (entry.rows !== undefined && (!Number.isSafeInteger(entry.rows) || Number(entry.rows) < 0)) { errors.push(`Manifest file entry ${index} rows must be a nonnegative safe integer`); entriesAreStructured = false }
  }
  if (Object.values(files).some(contents => typeof contents !== 'string')) { errors.push('Audit package file contents must all be strings'); entriesAreStructured = false }
  if (!entriesAreStructured) return errors
  manifest.files = manifestFileSnapshots
  const manifestFiles = manifestFileSnapshots as unknown as AuditPackage['manifest']['files']
  const packageFiles = Object.create(null) as Record<string, string>
  for (const [path, contents] of Object.entries(files)) packageFiles[path] = contents as string
  if (manifest.format !== 'accounting-audit-package') errors.push('Manifest format is not supported')
  if (manifest.version !== 1) errors.push('Manifest version is not supported')
  if (typeof manifest.tenantId !== 'string' || !manifest.tenantId.trim()) errors.push('Manifest tenantId must be nonblank')
  else if (manifest.tenantId !== manifest.tenantId.trim()) errors.push('Manifest tenantId must use canonical trimmed form')
  if (typeof manifest.createdAt !== 'string' || !isIsoInstant(manifest.createdAt)) errors.push('Manifest createdAt must be an ISO instant with an explicit offset')
  if (manifest.purpose !== 'AUDIT' && manifest.purpose !== 'MIGRATION') errors.push('Manifest purpose must be AUDIT or MIGRATION')
  if (typeof manifest.authorityReference !== 'string' || !manifest.authorityReference.trim()) errors.push(manifest.purpose === 'AUDIT' || manifest.purpose === 'MIGRATION' ? `Manifest authorityReference is required for ${manifest.purpose} purpose` : 'Manifest authorityReference must be nonblank')
  if (typeof manifest.packageChecksum !== 'string') errors.push('Manifest packageChecksum must be a string')
  const paths = manifestFiles.map(file => file.path)
  if (new Set(paths).size !== paths.length) errors.push('Manifest contains duplicate file paths')
  if (paths.some(path => !safePackagePath(path))) errors.push('Manifest contains an unsafe or non-normalized path')
  const actualFilePaths = Object.keys(packageFiles).sort(compareCanonicalText); const manifestPaths = [...paths].sort(compareCanonicalText)
  if (canonicalJson(actualFilePaths) !== canonicalJson(manifestPaths)) errors.push('File map does not exactly match manifest paths')
  const expectedDataPaths = DATASETS.map(name => `data/${name}.json`).sort(compareCanonicalText)
  const actualDataPaths = paths.filter(path => path.startsWith('data/')).sort(compareCanonicalText)
  if (canonicalJson(actualDataPaths) !== canonicalJson(expectedDataPaths)) errors.push('Manifest does not contain the exact required dataset set')
  const expectedPaths = [...expectedDataPaths, ...DOCUMENTATION_PATHS, ...REPORT_PATHS].sort(compareCanonicalText)
  if (canonicalJson(manifestPaths) !== canonicalJson(expectedPaths)) errors.push('Manifest does not contain the exact required package file set')
  for (const file of manifestFiles) {
    const contents = Object.hasOwn(packageFiles, file.path) ? packageFiles[file.path] : undefined
    if (contents === undefined) errors.push(`Missing file: ${file.path}`)
    else if (Buffer.byteLength(contents, 'utf8') !== file.bytes) errors.push(`Size mismatch: ${file.path}`)
    else if (sha256(contents) !== file.sha256) errors.push(`Checksum mismatch: ${file.path}`)
    if (contents !== undefined && file.path.startsWith('data/')) { try { const parsed: unknown = JSON.parse(contents); if (!Array.isArray(parsed)) errors.push(`Dataset is not an array: ${file.path}`); else if (file.rows !== parsed.length) errors.push(`Row count mismatch: ${file.path}`) } catch { errors.push(`Dataset is not valid JSON: ${file.path}`) } }
  }
  const { packageChecksum: _packageChecksum, ...checksumInput } = manifest
  try {
    if (sha256(canonicalJson(checksumInput)) !== manifest.packageChecksum) errors.push('Package checksum mismatch')
  } catch {
    errors.push('Package checksum input is not canonical')
  }
  const restored: Partial<Record<typeof DATASETS[number], readonly ExportRow[]>> = {}
  let datasetsAreStructured = true
  for (const name of DATASETS) {
    const path = `data/${name}.json`
    const contents = Object.hasOwn(packageFiles, path) ? packageFiles[path] : undefined
    if (typeof contents !== 'string') { datasetsAreStructured = false; continue }
    try {
      const rows = reviveCanonical(JSON.parse(contents))
      if (!Array.isArray(rows)) { datasetsAreStructured = false; continue }
      if (rows.some(row => !isRecord(row) || typeof row.tenantId !== 'string')) { errors.push(`Dataset ${name} must contain object rows with tenantId`); datasetsAreStructured = false; continue }
      if (typeof manifest.tenantId === 'string' && rows.some(row => row.tenantId !== manifest.tenantId)) { errors.push(`Dataset ${name} contains a row outside the manifest tenant`); datasetsAreStructured = false; continue }
      restored[name] = rows as ExportRow[]
    } catch {
      errors.push(`Dataset cannot be revived: data/${name}.json`); datasetsAreStructured = false
    }
  }
  if (datasetsAreStructured && DATASETS.every(name => restored[name])) {
    const source = restored as AuditExportSource
    let schemaIsValid = true
    try { validateAccountingSchema(source) } catch (error) { errors.push(`Dataset schema is invalid: ${error instanceof Error ? error.message : 'unknown validation error'}`); schemaIsValid = false }
    if (schemaIsValid) {
      for (const name of DATASETS) {
        const path = `data/${name}.json`
        if (packageFiles[path] !== canonicalJson(normalizeDatasetRows(name, source[name] ?? []))) errors.push(`Dataset is not canonical or deterministically ordered: ${path}`)
      }
      const counts = Object.fromEntries(DATASETS.map(name => [name, (source[name] ?? []).length])) as Record<typeof DATASETS[number], number>
      const expectedDocumentation = createDocumentation(counts)
      for (const path of DOCUMENTATION_PATHS) if (!Object.hasOwn(packageFiles, path) || packageFiles[path] !== expectedDocumentation[path]) errors.push(`Documentation does not match datasets/contracts: ${path}`)
      try {
        const expectedReports = createHumanReadableReports(source.fiscalYears as ExportRow[], source.journal as ExportRow[], source.journalLines as ExportRow[], source.chartMappings as ExportRow[], source.openingClosing as ExportRow[], (source.openItems ?? []) as ExportRow[], (source.cashBooks ?? []) as ExportRow[], (source.cashBookEntries ?? []) as ExportRow[], (source.cashDailyCloses ?? []) as ExportRow[])
        for (const path of REPORT_PATHS) if (!Object.hasOwn(packageFiles, path) || packageFiles[path] !== expectedReports[path]) errors.push(`Report does not match datasets: ${path}`)
      } catch (error) {
        errors.push(`Reports cannot be reproduced from datasets: ${error instanceof Error ? error.message : 'unknown validation error'}`)
      }
    }
  }
  return errors
}

export function importMigrationPackage(auditPackage: AuditPackage, authenticatedTargetTenantId: string, authenticator?: MigrationPackageAuthenticator): AuditExportSource {
  const captured = captureAuditPackage(auditPackage); if (typeof captured === 'string') throw new Error(`Invalid audit package: ${captured}`)
  const manifest = captured.manifest as unknown as AuditPackage['manifest']; const authenticity = captured.authenticity as AuditPackage['authenticity']
  if (manifest.format !== 'accounting-audit-package' || manifest.version !== 1 || manifest.purpose !== 'MIGRATION') throw new Error('Package format, version or purpose is not supported for migration.')
  if (typeof authenticatedTargetTenantId !== 'string' || !authenticatedTargetTenantId.trim() || authenticatedTargetTenantId !== authenticatedTargetTenantId.trim() || typeof manifest.tenantId !== 'string' || manifest.tenantId !== manifest.tenantId.trim() || manifest.tenantId !== authenticatedTargetTenantId) throw new Error('Authenticated migration target and package tenant must match in canonical trimmed form.')
  if (!authenticator || !authenticity || typeof authenticity.keyId !== 'string' || !authenticity.keyId.trim() || typeof authenticity.signature !== 'string' || !authenticity.signature.trim() || authenticity.keyId !== authenticator.keyId || authenticator.verify(authenticityPayload(manifest), authenticity.signature, authenticity.keyId) !== true) throw new Error('Migration package authenticity is not verified by the trusted external anchor.')
  const errors = verifyAuditPackageSnapshot(captured); if (errors.length) throw new Error(`Invalid audit package: ${errors.join('; ')}`)
  const restored = Object.fromEntries(DATASETS.map(name => {
    const rows: unknown = reviveCanonical(JSON.parse(captured.files[`data/${name}.json`] as string))
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || (row as { tenantId?: unknown }).tenantId !== authenticatedTargetTenantId)) throw new Error(`Dataset ${name} contains a row outside the authenticated tenant.`)
    return [name, rows]
  })) as unknown as AuditExportSource
  validateAccountingSchema(restored)
  return restored
}

export function reconcileRoundTrip(original: AuditExportSource, restored: AuditExportSource, tenantId: string) {
  const datasets = DATASETS.map(name => {
    const left = normalizeDatasetRows(name, (original[name] ?? []).filter(row => row.tenantId === tenantId)); const right = normalizeDatasetRows(name, (restored[name] ?? []).filter(row => row.tenantId === tenantId))
    return { name, rowsBefore: left.length, rowsAfter: right.length, checksumBefore: sha256(canonicalJson(left)), checksumAfter: sha256(canonicalJson(right)), matches: canonicalJson(left) === canonicalJson(right) }
  })
  return { matches: datasets.every(item => item.matches), datasets }
}

export function reconstructCashBooks(source: AuditExportSource) {
  validateAccountingSchema(source)
  return (source.cashBooks ?? []).map(master => ({
    id: String(master.id), tenantId: String(master.tenantId), location: String(master.location), register: String(master.register), timeZone: String(master.timeZone), currency: master.currency as 'EUR', glAccountId: String(master.glAccountId), retainedThrough: String(master.retainedThrough),
    entries: (source.cashBookEntries ?? []).filter(row => row.cashBookId === master.id).sort((left, right) => Number(left.sequence) - Number(right.sequence)).map(cashAuditEntryPayload),
    closes: (source.cashDailyCloses ?? []).filter(row => row.bookId === master.id).sort((left, right) => compareCanonicalText(String(left.businessDate), String(right.businessDate))).map(cashAuditClosePayload),
  }))
}

function createHumanReadableReports(fiscalYears: ExportRow[], journal: ExportRow[], lines: ExportRow[], accounts: ExportRow[], openingClosing: ExportRow[], openItems: ExportRow[], cashBooks: ExportRow[], cashBookEntries: ExportRow[], cashDailyCloses: ExportRow[]) {
  const byAccount = new Map(accounts.map(account => [String(account.accountId), account]))
  const byJournal = new Map(journal.map(entry => [entry.id, entry]))
  const byFiscalYear = new Map(fiscalYears.map(fiscalYear => [fiscalYear.id, fiscalYear]))
  const orderedYears = [...fiscalYears].sort((left, right) => compareCanonicalText(String(left.startDate), String(right.startDate)) || compareCanonicalText(String(left.endDate), String(right.endDate)) || compareCanonicalText(String(left.id), String(right.id)))
  const orderedAccounts = [...accounts].sort((left, right) => compareCanonicalText(String(left.accountId), String(right.accountId)))
  const openingByPeriodAccount = new Map(openingClosing.map(row => [periodAccountKey(row.fiscalYearId, row.accountId), row]))
  const totals = new Map<string, { debit: number; credit: number; journalLineIds: string[] }>()
  for (const line of lines) {
    const entry = byJournal.get(line.journalEntryId)!
    const key = periodAccountKey(entry.fiscalYearId, line.accountId)
    const value = totals.get(key) ?? { debit: 0, credit: 0, journalLineIds: [] }
    value.debit = addCents(value.debit, requireCents(line.debitCents, 'debitCents'))
    value.credit = addCents(value.credit, requireCents(line.creditCents, 'creditCents'))
    value.journalLineIds.push(String(line.id))
    totals.set(key, value)
  }
  const orderedJournals = [...journal].sort((left, right) => { const leftYear = byFiscalYear.get(left.fiscalYearId)!; const rightYear = byFiscalYear.get(right.fiscalYearId)!; return compareCanonicalText(String(leftYear.startDate), String(rightYear.startDate)) || compareCanonicalText(String(leftYear.endDate), String(rightYear.endDate)) || compareCanonicalText(String(left.bookingDate), String(right.bookingDate)) || Number(left.sequenceNumber) - Number(right.sequenceNumber) || compareCanonicalText(String(left.fiscalYearId), String(right.fiscalYearId)) || compareCanonicalText(String(left.id), String(right.id)) })
  const grundbuch = orderedJournals.flatMap(entry => lines.filter(line => line.journalEntryId === entry.id).sort((left, right) => compareCanonicalText(String(left.id), String(right.id))).map(line => [entry.fiscalYearId, entry.sequenceNumber, entry.bookingDate, entry.documentNumber, entry.description, line.accountId, byAccount.get(String(line.accountId))?.name ?? '', line.debitCents, line.creditCents].map(csv).join(';'))).join('\n')
  const accountSheetRows: string[] = []
  const trialRows: string[] = []
  const drilldownAccounts: Record<string, unknown>[] = []
  for (const fiscalYear of orderedYears) for (const account of orderedAccounts) {
    const fiscalYearId = String(fiscalYear.id); const accountId = String(account.accountId)
    const key = periodAccountKey(fiscalYearId, accountId); const balanceRow = openingByPeriodAccount.get(key)!
    const opening = Number(balanceRow.openingCents); const declaredClosing = Number(balanceRow.closingCents)
    const value = totals.get(key) ?? { debit: 0, credit: 0, journalLineIds: [] }
    const calculatedClosing = addCents(opening, addCents(value.debit, -value.credit))
    accountSheetRows.push([fiscalYearId, accountId, account.name ?? '', 'OPENING', '', fiscalYear.startDate, '', 'Opening balance', opening, 0, 0, opening, '', '', '', ''].map(csv).join(';'))
    let runningBalance = opening
    const accountLines = lines.filter(line => line.accountId === account.accountId && byJournal.get(line.journalEntryId)?.fiscalYearId === fiscalYear.id).sort((left, right) => { const leftEntry = byJournal.get(left.journalEntryId)!; const rightEntry = byJournal.get(right.journalEntryId)!; return compareCanonicalText(String(leftEntry.bookingDate), String(rightEntry.bookingDate)) || Number(leftEntry.sequenceNumber) - Number(rightEntry.sequenceNumber) || compareCanonicalText(String(left.id), String(right.id)) })
    for (const line of accountLines) {
      const entry = byJournal.get(line.journalEntryId)!; const debit = Number(line.debitCents); const credit = Number(line.creditCents)
      runningBalance = addCents(runningBalance, addCents(debit, -credit))
      accountSheetRows.push([fiscalYearId, accountId, account.name ?? '', 'POSTING', entry.sequenceNumber, entry.bookingDate, entry.documentNumber, entry.description, opening, debit, credit, runningBalance, '', '', '', ''].map(csv).join(';'))
    }
    const closingDifference = addCents(calculatedClosing, -declaredClosing); const reconciled = closingDifference === 0
    accountSheetRows.push([fiscalYearId, accountId, account.name ?? '', 'CLOSING', '', fiscalYear.endDate, '', 'Closing balance reconciliation', opening, value.debit, value.credit, calculatedClosing, calculatedClosing, declaredClosing, closingDifference, reconciled].map(csv).join(';'))
    trialRows.push([fiscalYearId, fiscalYear.startDate, fiscalYear.endDate, accountId, account.name ?? '', opening, value.debit, value.credit, calculatedClosing, declaredClosing, calculatedClosing === declaredClosing].map(csv).join(';'))
    drilldownAccounts.push({ fiscalYearId, periodStart: fiscalYear.startDate, periodEnd: fiscalYear.endDate, accountId, accountName: account.name ?? '', openingCents: opening, debitCents: value.debit, creditCents: value.credit, calculatedClosingCents: calculatedClosing, declaredClosingCents: declaredClosing, reconciled: calculatedClosing === declaredClosing, journalLineIds: value.journalLineIds })
  }
  const header = 'fiscalYearId;sequence;date;document;description;account;accountName;debitCents;creditCents\n'
  const accountSheetHeader = 'fiscalYearId;account;accountName;rowType;sequence;date;document;description;openingCents;debitCents;creditCents;balanceCents;calculatedClosingCents;declaredClosingCents;closingDifferenceCents;reconciled\n'
  const trialHeader = 'fiscalYearId;periodStart;periodEnd;account;accountName;openingCents;debitCents;creditCents;calculatedClosingCents;declaredClosingCents;reconciled\n'
  return { 'reports/Grundbuch.csv': header + grundbuch, 'reports/Hauptbuch-Kontenblaetter.csv': accountSheetHeader + accountSheetRows.join('\n'), 'reports/SuSa.csv': trialHeader + trialRows.join('\n'), 'reports/statement-drilldown.json': canonicalJson({ accounts: drilldownAccounts }), 'reports/open-items.json': canonicalJson(openItems), 'reports/cash-book.json': canonicalJson({ books: cashBooks, entries: cashBookEntries, dailyCloses: cashDailyCloses }) }
}
function periodAccountKey(fiscalYearId: unknown, accountId: unknown) { return canonicalJson([String(fiscalYearId), String(accountId)]) }
function normalizeDatasetRows(name: typeof DATASETS[number], rows: readonly ExportRow[]) { const keys = PRIMARY_KEYS[name]; return [...rows].sort((left, right) => { for (const key of keys) { if (name === 'cashBookEntries' && key === 'sequence' && Number.isSafeInteger(left.sequence) && Number.isSafeInteger(right.sequence)) { const leftSequence = Number(left.sequence); const rightSequence = Number(right.sequence); if (leftSequence !== rightSequence) return leftSequence < rightSequence ? -1 : 1; continue } const comparison = compareCanonicalText(String(left[key]), String(right[key])); if (comparison) return comparison } return 0 }) }
function normalizeDatasetOrder(source: AuditExportSource): AuditExportSource { return Object.fromEntries(DATASETS.map(name => [name, normalizeDatasetRows(name, source[name] ?? [])])) as unknown as AuditExportSource }
function createDocumentation(counts: Record<typeof DATASETS[number], number>) { return { 'documentation/README.txt': PACKAGE_README, 'documentation/schema.json': canonicalJson({ version: 1, relationships: SCHEMA_RELATIONSHIPS, datasets: Object.fromEntries(DATASETS.map(name => [name, { path: `data/${name}.json`, primaryKey: PRIMARY_KEYS[name], rows: counts[name] }])) }) } }
function csv(value: unknown) { const text = String(value ?? ''); const spreadsheetSafe = typeof value !== 'number' && /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text; return `"${spreadsheetSafe.replaceAll('"', '""')}"` }
function sha256(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex') }
function requireCents(value: unknown, name: string) { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`Audit report ${name} must be nonnegative safe integer cents.`); return value as number }
function addCents(left: number, right: number) { const value = left + right; if (!Number.isSafeInteger(value)) throw new Error('Audit report totals exceed safe integer limits.'); return value }
interface CapturedAuditPackage { manifest: Record<string, unknown>; files: Record<string, unknown>; authenticity?: Record<string, unknown> }
function captureAuditPackage(value: unknown): CapturedAuditPackage | string {
  if (!isPlainRecord(value)) return 'Audit package must be a plain object'
  const outer = captureDataRecord(value, 'Audit package outer object'); if (typeof outer === 'string') return outer
  if (!isPlainRecord(outer.manifest)) return 'Audit package manifest must be an own plain object'
  if (!isPlainRecord(outer.files)) return 'Audit package files must be an own plain object map'
  const manifest = captureDataRecord(outer.manifest, 'Audit package manifest'); if (typeof manifest === 'string') return manifest
  const files = captureDataRecord(outer.files, 'Audit package files map'); if (typeof files === 'string') return files
  if (Array.isArray(manifest.files)) {
    const entries: Record<string, unknown>[] = []
    for (let index = 0; index < manifest.files.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(manifest.files, String(index)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) return `Manifest files entry ${index} must be an own data property without accessors`
      if (!isPlainRecord(descriptor.value)) { entries.push(descriptor.value as never); continue }
      const entry = captureDataRecord(descriptor.value, `Manifest file entry ${index}`); if (typeof entry === 'string') return entry; entries.push(entry)
    }
    manifest.files = entries
  }
  let authenticity: Record<string, unknown> | undefined
  if (outer.authenticity !== undefined) { if (!isPlainRecord(outer.authenticity)) return 'Audit package authenticity must be an own plain object'; const captured = captureDataRecord(outer.authenticity, 'Audit package authenticity'); if (typeof captured === 'string') return captured; authenticity = captured }
  return { manifest, files, ...(authenticity ? { authenticity } : {}) }
}
function captureDataRecord(value: Record<string, unknown>, label: string): Record<string, unknown> | string { const snapshot = Object.create(null) as Record<string, unknown>; for (const key of Reflect.ownKeys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !Object.hasOwn(descriptor, 'value')) return `${label} must use own data properties without accessors`; if (typeof key === 'string' && descriptor.enumerable) snapshot[key] = descriptor.value } return snapshot }
function captureExportAccess(value: unknown): ExportAccess { if (!isRecord(value)) throw new Error('Export access must be a structured object.'); const snapshot = {} as Record<keyof ExportAccess, unknown>; for (const field of ['tenantId', 'actorId', 'authorityReference', 'accessedAt', 'purpose'] as const) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Export access fields must be own enumerable data properties without accessors.'); snapshot[field] = descriptor.value } return snapshot as ExportAccess }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function isPlainRecord(value: unknown): value is Record<string, unknown> { if (!isRecord(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null }
function ownSnapshot(value: Record<string, unknown>) { const snapshot = Object.create(null) as Record<string, unknown>; for (const [key, nested] of Object.entries(value)) snapshot[key] = nested; return snapshot }
function safePackagePath(value: string) { return value.length > 0 && !value.includes('\\') && !value.startsWith('/') && !/^[A-Za-z]:/.test(value) && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..') }
function isIsoInstant(value: string) { const date = value.slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false; const calendarDate = new Date(`${date}T00:00:00.000Z`); if (!Number.isFinite(calendarDate.getTime()) || calendarDate.toISOString().slice(0, 10) !== date) return false; return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) }
function requireIsoInstant(value: string, name: string) { if (typeof value !== 'string' || !isIsoInstant(value)) throw new Error(`${name} must be an ISO instant with an explicit offset.`) }
export function canonicalJson(value: unknown): string { return JSON.stringify(sortValue(value)) }
function validateAccountingSchema(source: AuditExportSource) {
  const requireText = (row: ExportRow, field: string, dataset: string) => { if (typeof row[field] !== 'string' || !(row[field] as string).trim()) throw new Error(`${dataset}.${field} is required text.`) }
  const requireOnlyFields = (row: ExportRow, dataset: string, allowed: readonly string[]) => { const allowedSet = new Set(allowed); const unexpected = Object.keys(row).find(field => !allowedSet.has(field)); if (unexpected) throw new Error(`${dataset} contains unsupported field: ${unexpected}.`) }
  const requireUnique = (dataset: string, rows: readonly ExportRow[], key: (row: ExportRow) => string) => { const keys = rows.map(key); if (new Set(keys).size !== keys.length) throw new Error(`${dataset} contains duplicate primary keys.`) }
  for (const row of source.masterData) requireText(row, 'id', 'masterData')
  for (const row of source.chartMappings) { requireText(row, 'accountId', 'chartMappings'); requireText(row, 'name', 'chartMappings') }
  for (const row of source.fiscalYears) { requireText(row, 'id', 'fiscalYears'); if (typeof row.startDate !== 'string' || !validDateOnly(row.startDate) || typeof row.endDate !== 'string' || !validDateOnly(row.endDate) || row.startDate > row.endDate) throw new Error('fiscalYears require a valid startDate and endDate in chronological order.'); const anniversary = new Date(`${row.startDate}T00:00:00.000Z`); anniversary.setUTCFullYear(anniversary.getUTCFullYear() + 1); if (Date.parse(`${row.endDate}T00:00:00.000Z`) >= anniversary.getTime()) throw new Error('Fiscal-year periods may not exceed twelve months.') }
  for (const row of source.journal) { requireText(row, 'id', 'journal'); requireText(row, 'fiscalYearId', 'journal'); if (!Number.isSafeInteger(row.sequenceNumber) || Number(row.sequenceNumber) <= 0) throw new Error('journal.sequenceNumber must be a positive safe integer.'); if (typeof row.bookingDate !== 'string' || !validDateOnly(row.bookingDate)) throw new Error('journal.bookingDate must be a strict real date.') }
  for (const row of source.journalLines) { requireText(row, 'id', 'journalLines'); requireText(row, 'journalEntryId', 'journalLines'); requireText(row, 'accountId', 'journalLines'); const debit = requireCents(row.debitCents, 'journalLines.debitCents'); const credit = requireCents(row.creditCents, 'journalLines.creditCents'); if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) throw new Error('Migration journal lines must post an effective amount on exactly one side.') }
  for (const row of source.openingClosing) { requireText(row, 'fiscalYearId', 'openingClosing'); requireText(row, 'accountId', 'openingClosing'); if (!Number.isSafeInteger(row.openingCents) || !Number.isSafeInteger(row.closingCents)) throw new Error('openingClosing openingCents and closingCents must be safe integer cents.') }
  for (const row of source.vatDetails) { requireText(row, 'id', 'vatDetails'); requireText(row, 'journalLineId', 'vatDetails'); requireText(row, 'taxCode', 'vatDetails'); requireText(row, 'returnPeriod', 'vatDetails'); requireText(row, 'submissionId', 'vatDetails'); if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(row.returnPeriod)) || !Number.isSafeInteger(row.baseCents) || !Number.isSafeInteger(row.taxAmountCents)) throw new Error('VAT migration rows require a real return period and safe base/tax cents.') }
  for (const row of source.evidence) { requireText(row, 'id', 'evidence'); requireText(row, 'fileName', 'evidence'); requireText(row, 'mediaType', 'evidence'); requireText(row, 'sha256', 'evidence'); if (!(row.bytes instanceof Uint8Array) || !Number.isSafeInteger(row.sizeBytes) || row.sizeBytes !== row.bytes.byteLength || !/^[a-f0-9]{64}$/i.test(String(row.sha256)) || createHash('sha256').update(row.bytes).digest('hex') !== String(row.sha256).toLowerCase()) throw new Error('Evidence requires self-contained bytes, metadata, size and matching checksum; a matching SHA-256 checksum is required.') }
  for (const row of source.auditEvents) { requireText(row, 'id', 'auditEvents'); requireText(row, 'action', 'auditEvents'); requireText(row, 'targetId', 'auditEvents') }
  for (const row of source.taxSubmissions) { requireText(row, 'id', 'taxSubmissions'); requireText(row, 'fiscalYearId', 'taxSubmissions'); requireText(row, 'kind', 'taxSubmissions'); if (row.kind === 'VAT') { requireText(row, 'returnPeriod', 'taxSubmissions'); if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(String(row.returnPeriod))) throw new Error('VAT taxSubmissions require an authoritative real returnPeriod.') } }
  for (const row of source.openItems ?? []) { requireText(row, 'id', 'openItems'); if (!Number.isSafeInteger(row.outstandingCents) || Number(row.outstandingCents) < 0) throw new Error('openItems.outstandingCents must be nonnegative safe integer cents.') }
  for (const row of source.cashBooks ?? []) { requireOnlyFields(row, 'cashBooks', ['version', 'id', 'tenantId', 'location', 'register', 'timeZone', 'currency', 'glAccountId', 'retainedThrough']); for (const field of ['id', 'location', 'register', 'timeZone', 'glAccountId', 'retainedThrough'] as const) requireText(row, field, 'cashBooks'); if (row.version !== 1 || row.currency !== 'EUR' || !validDateOnly(String(row.retainedThrough))) throw new Error('cashBooks require protocol version 1, EUR currency and a real retention date.'); try { new Intl.DateTimeFormat('en-US', { timeZone: String(row.timeZone) }).format(new Date(0)) } catch { throw new Error('cashBooks.timeZone must be a valid IANA timezone.') } }
  for (const row of source.cashBookEntries ?? []) {
    requireOnlyFields(row, 'cashBookEntries', ['tenantId', 'cashBookId', 'fiscalYearId', 'id', 'sequence', 'journalEntryId', 'occurredAt', 'businessDate', 'type', 'amountCents', 'description', 'evidenceIds', 'createdAt', 'createdBy', 'source', 'externalId', 'correctsEntryId', 'replacementEntryId'])
    for (const field of ['id', 'cashBookId', 'fiscalYearId', 'journalEntryId', 'occurredAt', 'businessDate', 'description', 'createdAt', 'createdBy'] as const) requireText(row, field, 'cashBookEntries')
    if (!Number.isSafeInteger(row.sequence) || Number(row.sequence) <= 0 || !Number.isSafeInteger(row.amountCents) || Number(row.amountCents) <= 0) throw new Error('cashBookEntries require positive safe sequence and amountCents.')
    if (!['RECEIPT', 'PAYMENT', 'STORNO'].includes(String(row.type)) || !['MANUAL', 'POS_IMPORT'].includes(String(row.source)) || !validDateOnly(String(row.businessDate)) || !isIsoInstant(String(row.occurredAt)) || !isIsoInstant(String(row.createdAt)) || Date.parse(String(row.createdAt)) < Date.parse(String(row.occurredAt))) throw new Error('cashBookEntries contain an invalid type, source, business date or chronology.')
    const capturedEvidenceIds = captureDenseDataArray(row.evidenceIds); if (capturedEvidenceIds === null || capturedEvidenceIds.length === 0 || capturedEvidenceIds.some(value => typeof value !== 'string' || !value.trim())) throw new Error('cashBookEntries require dense nonblank evidenceIds.')
    if (Object.hasOwn(row, 'externalId') && (typeof row.externalId !== 'string' || !row.externalId.trim() || row.externalId !== row.externalId.trim())) throw new Error('cashBookEntries.externalId must be a nonblank string in canonical trimmed form when supplied.')
    if (row.source === 'POS_IMPORT' && !Object.hasOwn(row, 'externalId')) throw new Error('cashBookEntries POS imports require an externalId.')
    for (const field of ['correctsEntryId', 'replacementEntryId'] as const) if (row[field] !== undefined && (typeof row[field] !== 'string' || !row[field].trim())) throw new Error(`cashBookEntries.${field} must be nonblank when supplied.`)
  }
  for (const row of source.cashDailyCloses ?? []) {
    requireOnlyFields(row, 'cashDailyCloses', ['tenantId', 'id', 'fiscalYearId', 'bookId', 'businessDate', 'openingBalanceCents', 'receiptsCents', 'paymentsCents', 'expectedBalanceCents', 'countedBalanceCents', 'differenceCents', 'resolution', 'resolutionJournalEntryId', 'signedBy', 'signedAt', 'approvedBy', 'approvedAt', 'entrySequenceThrough', 'entryChecksum', 'checksum'])
    for (const field of ['id', 'bookId', 'fiscalYearId', 'businessDate', 'signedBy', 'signedAt', 'approvedBy', 'approvedAt', 'entryChecksum', 'checksum'] as const) requireText(row, field, 'cashDailyCloses')
    if (!validDateOnly(String(row.businessDate)) || !isIsoInstant(String(row.signedAt)) || !isIsoInstant(String(row.approvedAt)) || Date.parse(String(row.signedAt)) > Date.parse(String(row.approvedAt)) || !Number.isSafeInteger(row.entrySequenceThrough) || Number(row.entrySequenceThrough) < 0) throw new Error('cashDailyCloses contain an invalid business date, sequence or approval chronology.')
    if (Object.hasOwn(row, 'resolution') && (typeof row.resolution !== 'string' || !row.resolution.trim())) throw new Error('cashDailyCloses.resolution must be a nonblank string when supplied.')
    if (Object.hasOwn(row, 'resolutionJournalEntryId') && (typeof row.resolutionJournalEntryId !== 'string' || !row.resolutionJournalEntryId.trim())) throw new Error('cashDailyCloses.resolutionJournalEntryId must be nonblank when supplied.')
    for (const field of ['openingBalanceCents', 'receiptsCents', 'paymentsCents', 'expectedBalanceCents', 'countedBalanceCents', 'differenceCents'] as const) if (!Number.isSafeInteger(row[field])) throw new Error(`cashDailyCloses.${field} must be safe integer cents.`)
  }
  requireUnique('masterData', source.masterData, row => String(row.id)); requireUnique('chartMappings', source.chartMappings, row => String(row.accountId)); requireUnique('fiscalYears', source.fiscalYears, row => String(row.id)); requireUnique('journal', source.journal, row => String(row.id)); requireUnique('journalLines', source.journalLines, row => String(row.id)); requireUnique('openingClosing', source.openingClosing, row => canonicalJson([row.fiscalYearId, row.accountId])); requireUnique('vatDetails', source.vatDetails, row => String(row.id)); requireUnique('evidence', source.evidence, row => String(row.id)); requireUnique('auditEvents', source.auditEvents, row => String(row.id)); requireUnique('taxSubmissions', source.taxSubmissions, row => String(row.id)); requireUnique('openItems', source.openItems ?? [], row => String(row.id)); requireUnique('cashBooks', source.cashBooks ?? [], row => String(row.id)); requireUnique('cashBookEntries', source.cashBookEntries ?? [], row => canonicalJson([row.cashBookId, row.sequence])); requireUnique('cashDailyCloses', source.cashDailyCloses ?? [], row => canonicalJson([row.bookId, row.businessDate])); requireUnique('cashDailyCloses id', source.cashDailyCloses ?? [], row => String(row.id))
  requireUnique('journal sequence', source.journal, row => canonicalJson([row.fiscalYearId, row.sequenceNumber]))
  const orderedFiscalYears = [...source.fiscalYears].sort((left, right) => compareCanonicalText(String(left.startDate), String(right.startDate)) || compareCanonicalText(String(left.endDate), String(right.endDate))); for (let index = 1; index < orderedFiscalYears.length; index++) if (String(orderedFiscalYears[index].startDate) <= String(orderedFiscalYears[index - 1].endDate)) throw new Error(`Fiscal-year periods overlap: ${String(orderedFiscalYears[index - 1].id)} and ${String(orderedFiscalYears[index].id)}.`)
  for (const row of source.journal) { requireText(row, 'documentNumber', 'journal'); requireText(row, 'description', 'journal') }
  const journalById = new Map(source.journal.map(row => [row.id, row])); const journals = new Set(journalById.keys()); const accounts = new Set(source.chartMappings.map(row => row.accountId)); const lineById = new Map(source.journalLines.map(row => [row.id, row])); const fiscalYears = new Map(source.fiscalYears.map(row => [row.id, row])); const submissionById = new Map(source.taxSubmissions.map(row => [row.id, row]))
  if ((source.chartMappings.length || source.journal.length || source.openingClosing.length || source.taxSubmissions.length || (source.cashBookEntries?.length ?? 0) || (source.cashDailyCloses?.length ?? 0)) && !source.fiscalYears.length) throw new Error('Migration requires authoritative fiscalYears for accounting data.')
  if (source.journal.some(row => { const fiscalYear = fiscalYears.get(row.fiscalYearId); return !fiscalYear || String(row.bookingDate) < String(fiscalYear.startDate) || String(row.bookingDate) > String(fiscalYear.endDate) })) throw new Error('Migration journal fiscal-year relationships or booking periods are invalid.')
  if (source.journalLines.some(row => !journals.has(row.journalEntryId) || !accounts.has(row.accountId))) throw new Error('Migration journal-line relationships are invalid.')
  if (source.openingClosing.some(row => !fiscalYears.has(row.fiscalYearId) || !accounts.has(row.accountId))) throw new Error('Migration opening/closing fiscal-year or account relationships are invalid.')
  const openingByPeriodAccount = new Map(source.openingClosing.map(row => [periodAccountKey(row.fiscalYearId, row.accountId), row]))
  for (const fiscalYear of source.fiscalYears) for (const account of source.chartMappings) if (!openingByPeriodAccount.has(periodAccountKey(fiscalYear.id, account.accountId))) throw new Error(`Migration openingClosing is missing account ${String(account.accountId)} for fiscal year ${String(fiscalYear.id)}.`)
  for (const journal of source.journal) { const grouped = source.journalLines.filter(line => line.journalEntryId === journal.id); if (!grouped.length) throw new Error(`Migration journal ${String(journal.id)} has no effective postings.`); let debit = 0; let credit = 0; for (const line of grouped) { debit = addCents(debit, Number(line.debitCents)); credit = addCents(credit, Number(line.creditCents)) } if (debit !== credit) throw new Error(`Migration journal ${String(journal.id)} is not debit/credit balanced.`) }
  if (source.evidence.some(row => row.journalEntryId !== undefined && !journals.has(row.journalEntryId)) || source.vatDetails.some(row => { const line = lineById.get(row.journalLineId); const journal = line ? journalById.get(line.journalEntryId) : undefined; const submission = submissionById.get(row.submissionId); return !line || !journal || !submission || submission.kind !== 'VAT' || submission.fiscalYearId !== journal.fiscalYearId || submission.returnPeriod !== row.returnPeriod })) throw new Error('Migration evidence/VAT relationships or fiscal-year relationships are invalid: VAT submission kind or fiscal-year linkage, including exact return period.')
  if (source.taxSubmissions.some(row => { if (row.kind !== 'VAT') return false; const fiscalYear = fiscalYears.get(row.fiscalYearId); if (!fiscalYear) return false; const returnPeriod = String(row.returnPeriod); return returnPeriod < String(fiscalYear.startDate).slice(0, 7) || returnPeriod > String(fiscalYear.endDate).slice(0, 7) })) throw new Error('VAT tax-submission returnPeriod must fall within its referenced fiscal year inclusive start/end months.')
  if (source.taxSubmissions.some(row => !fiscalYears.has(row.fiscalYearId))) throw new Error('Migration tax-submission fiscal-year relationships are invalid.')
  validateCashAuditDatasets(source.cashBooks ?? [], source.cashBookEntries ?? [], source.cashDailyCloses ?? [], fiscalYears, new Set(source.evidence.map(row => row.id)), accounts, journalById, source.journalLines)
  const movements = new Map<string, number>()
  for (const line of source.journalLines) { const journal = source.journal.find(entry => entry.id === line.journalEntryId)!; const key = periodAccountKey(journal.fiscalYearId, line.accountId); movements.set(key, addCents(movements.get(key) ?? 0, addCents(Number(line.debitCents), -Number(line.creditCents)))) }
  for (const row of source.openingClosing) { const calculatedClosing = addCents(Number(row.openingCents), movements.get(periodAccountKey(row.fiscalYearId, row.accountId)) ?? 0); if (calculatedClosing !== row.closingCents) throw new Error(`Migration opening/closing does not reconcile for account ${String(row.accountId)} in fiscal year ${String(row.fiscalYearId)}.`) }
}
function cashAuditEntryPayload(row: ExportRow) { return { id: row.id, sequence: row.sequence, journalEntryId: row.journalEntryId, occurredAt: row.occurredAt, businessDate: row.businessDate, type: row.type, amountCents: row.amountCents, description: row.description, evidenceIds: row.evidenceIds, createdAt: row.createdAt, createdBy: row.createdBy, source: row.source, ...(row.externalId !== undefined ? { externalId: row.externalId } : {}), ...(row.correctsEntryId !== undefined ? { correctsEntryId: row.correctsEntryId } : {}), ...(row.replacementEntryId !== undefined ? { replacementEntryId: row.replacementEntryId } : {}) } }
function cashAuditClosePayload(row: ExportRow) { return { bookId: row.bookId, businessDate: row.businessDate, openingBalanceCents: row.openingBalanceCents, receiptsCents: row.receiptsCents, paymentsCents: row.paymentsCents, expectedBalanceCents: row.expectedBalanceCents, countedBalanceCents: row.countedBalanceCents, differenceCents: row.differenceCents, ...(row.resolution !== undefined ? { resolution: row.resolution } : {}), ...(row.resolutionJournalEntryId !== undefined ? { resolutionJournalEntryId: row.resolutionJournalEntryId } : {}), signedBy: row.signedBy, signedAt: row.signedAt, approvedBy: row.approvedBy, approvedAt: row.approvedAt, entrySequenceThrough: row.entrySequenceThrough, entryChecksum: row.entryChecksum, checksum: row.checksum } }
function validateCashAuditDatasets(masters: readonly ExportRow[], entries: readonly ExportRow[], closes: readonly ExportRow[], fiscalYears: ReadonlyMap<unknown, ExportRow>, evidenceIds: ReadonlySet<unknown>, accountIds: ReadonlySet<unknown>, journals: ReadonlyMap<unknown, ExportRow>, journalLines: readonly ExportRow[]) {
  const inFiscalYear = (row: ExportRow) => { const fiscalYear = fiscalYears.get(row.fiscalYearId); const date = String(row.businessDate); return fiscalYear && String(fiscalYear.startDate) <= date && date <= String(fiscalYear.endDate) }
  if (entries.some(row => !inFiscalYear(row)) || closes.some(row => !inFiscalYear(row))) throw new Error('Cash audit fiscal-year relationships or business dates are invalid.')
  if (entries.some(row => { const captured = captureDenseDataArray(row.evidenceIds); return captured === null || captured.some(evidenceId => !evidenceIds.has(evidenceId)) })) throw new Error('Cash audit entries contain an orphan evidence relationship.')
  if (masters.some(row => !accountIds.has(row.glAccountId))) throw new Error('Cash audit masters contain an orphan GL-account relationship.')
  for (const master of masters) { const recordDates = [...entries.filter(row => row.cashBookId === master.id).map(row => String(row.businessDate)), ...closes.filter(row => row.bookId === master.id).map(row => String(row.businessDate))]; const latestRecordDate = recordDates.sort(compareCanonicalText).at(-1); if (latestRecordDate !== undefined && String(master.retainedThrough) < latestRecordDate) throw new Error('Cash audit master retention deadline precedes its latest retained entry or close.') }
  const masterById = new Map(masters.map(row => [row.id, row])); if (entries.some(row => !masterById.has(row.cashBookId)) || closes.some(row => !masterById.has(row.bookId))) throw new Error('Cash audit entries or closes contain an orphan cash-book relationship.')
  if (entries.some(row => masterById.get(row.cashBookId)?.tenantId !== row.tenantId) || closes.some(row => masterById.get(row.bookId)?.tenantId !== row.tenantId)) throw new Error('Cash audit entries and closes must match their cash-book tenant.')
  const bookIds = new Set([...entries.map(row => String(row.cashBookId)), ...closes.map(row => String(row.bookId))])
  const claimedJournalPostings = new Set<string>()
  for (const bookId of bookIds) {
    const master = masterById.get(bookId)!
    const bookEntries = entries.filter(row => row.cashBookId === bookId).sort((left, right) => Number(left.sequence) - Number(right.sequence))
    const externalKeys = bookEntries.filter(row => row.externalId !== undefined).map(row => canonicalJson([row.source, row.externalId])); if (new Set(externalKeys).size !== externalKeys.length) throw new Error(`Cash audit entries for ${bookId} contain duplicate source IDs.`)
    for (let index = 0; index < bookEntries.length; index++) {
      const entry = bookEntries[index]
      if (entry.sequence !== index + 1 || entry.id !== `${bookId}:${index + 1}`) throw new Error(`Cash audit entries for ${bookId} require contiguous sequences and derived IDs.`)
      if (String(entry.occurredAt) !== canonicalIsoInstant(String(entry.occurredAt)) || String(entry.createdAt) !== canonicalIsoInstant(String(entry.createdAt)) || localDate(String(entry.occurredAt), String(master.timeZone)) !== entry.businessDate) throw new Error(`Cash audit entry ${String(entry.id)} timestamps or register business date are invalid.`)
      if (index && (Date.parse(String(entry.occurredAt)) < Date.parse(String(bookEntries[index - 1].occurredAt)) || Date.parse(String(entry.createdAt)) < Date.parse(String(bookEntries[index - 1].createdAt)))) throw new Error(`Cash audit entries for ${bookId} violate append chronology.`)
      if (entry.type === 'STORNO') {
        const original = bookEntries.slice(0, index).find(row => row.id === entry.correctsEntryId)
        if (!original || original.type === 'STORNO' || original.amountCents !== entry.amountCents || bookEntries.slice(0, index).some(row => row.type === 'STORNO' && row.correctsEntryId === original.id)) throw new Error(`Cash audit entries for ${bookId} contain an orphan, duplicate or invalid Storno.`)
        if (entry.replacementEntryId !== undefined) { const replacement = bookEntries.slice(index + 1).find(row => row.id === entry.replacementEntryId); if (!replacement || replacement.type === 'STORNO' || replacement.correctsEntryId !== original.id) throw new Error(`Cash audit entries for ${bookId} contain a nonreciprocal replacement link.`) }
      } else if (entry.correctsEntryId !== undefined) {
        const original = bookEntries.slice(0, index).find(row => row.id === entry.correctsEntryId); const storno = bookEntries.slice(0, index).find(row => row.type === 'STORNO' && row.correctsEntryId === original?.id)
        if (!original || !storno || storno.replacementEntryId !== entry.id || entry.replacementEntryId !== undefined) throw new Error(`Cash audit entries for ${bookId} contain an orphan or nonreciprocal replacement.`)
      } else if (entry.replacementEntryId !== undefined) throw new Error(`Cash audit entries for ${bookId} contain an arbitrary replacement link.`)
    }
    const validatePosting = (journalEntryId: unknown, expectedAmountCents: number, businessDate: unknown, fiscalYearId: unknown, tenantId: unknown, label: string) => {
      const claimKey = canonicalJson([journalEntryId, master.glAccountId]); if (claimedJournalPostings.has(claimKey)) throw new Error('A journal posting cannot be claimed by more than one cash movement group or count resolution.'); claimedJournalPostings.add(claimKey)
      const journal = journals.get(journalEntryId)
      const postingLines = journalLines.filter(line => line.journalEntryId === journalEntryId && line.accountId === master.glAccountId)
      const postedAmountCents = postingLines.reduce((sum, line) => addCents(sum, addCents(Number(line.debitCents), -Number(line.creditCents))), 0)
      if (!journal || journal.tenantId !== tenantId || master.tenantId !== tenantId || journal.fiscalYearId !== fiscalYearId || journal.bookingDate !== businessDate || postingLines.length === 0 || postingLines.some(line => line.tenantId !== tenantId) || postedAmountCents !== expectedAmountCents) throw new Error(`${label} is not bound to a matching tenant, fiscal-period, date, GL-account and amount journal posting.`)
    }
    const bookCloses = closes.filter(row => row.bookId === bookId).sort((left, right) => compareCanonicalText(String(left.businessDate), String(right.businessDate)))
    let priorSequence = 0; let priorCounted = 0; let priorDate = ''; let priorFinalization = Number.NEGATIVE_INFINITY
    for (const close of bookCloses) {
      if (close.id !== `${bookId}:${String(close.businessDate)}` || String(close.businessDate) <= priorDate || Number(close.entrySequenceThrough) < priorSequence || Number(close.entrySequenceThrough) > bookEntries.length) throw new Error(`Cash audit closes for ${bookId} contain an orphan, invalid ID or nonchronological sequence.`)
      const covered = bookEntries.filter(entry => Number(entry.sequence) > priorSequence && Number(entry.sequence) <= Number(close.entrySequenceThrough))
      const dated = bookEntries.filter(entry => entry.businessDate === close.businessDate)
      if (covered.length !== dated.length || covered.some((entry, index) => entry !== dated[index])) throw new Error(`Cash audit close ${String(close.id)} does not cover its dated entries exactly once.`)
      const receipts = covered.filter(entry => entry.type === 'RECEIPT').reduce((sum, entry) => addCents(sum, Number(entry.amountCents)), 0)
      const payments = covered.filter(entry => entry.type === 'PAYMENT').reduce((sum, entry) => addCents(sum, Number(entry.amountCents)), 0)
      const storno = covered.filter(entry => entry.type === 'STORNO').reduce((sum, entry) => { const original = bookEntries.find(value => value.id === entry.correctsEntryId)!; return addCents(sum, original.type === 'RECEIPT' ? -Number(entry.amountCents) : Number(entry.amountCents)) }, 0)
      const expected = addCents(addCents(addCents(priorCounted, receipts), -payments), storno); const difference = addCents(Number(close.countedBalanceCents), -expected)
      if (close.openingBalanceCents !== priorCounted || close.receiptsCents !== receipts || close.paymentsCents !== payments || close.expectedBalanceCents !== expected || close.differenceCents !== difference || Number(close.countedBalanceCents) < 0 || expected < 0 || (difference !== 0 && (typeof close.resolution !== 'string' || !close.resolution.trim() || typeof close.resolutionJournalEntryId !== 'string' || !close.resolutionJournalEntryId.trim())) || (difference === 0 && close.resolutionJournalEntryId !== undefined)) throw new Error(`Cash audit close ${String(close.id)} financial totals do not reconcile.`)
      if (difference !== 0) validatePosting(close.resolutionJournalEntryId, difference, close.businessDate, close.fiscalYearId, close.tenantId, `Cash audit count resolution ${String(close.id)}`)
      const lastCoveredInstant = covered.reduce((latest, entry) => Math.max(latest, Date.parse(String(entry.occurredAt)), Date.parse(String(entry.createdAt))), Number.NEGATIVE_INFINITY)
      if (String(close.signedAt) !== canonicalIsoInstant(String(close.signedAt)) || String(close.approvedAt) !== canonicalIsoInstant(String(close.approvedAt)) || localDate(String(close.signedAt), String(master.timeZone)) < String(close.businessDate) || Date.parse(String(close.signedAt)) < lastCoveredInstant || Date.parse(String(close.signedAt)) < priorFinalization || Date.parse(String(close.approvedAt)) < priorFinalization) throw new Error(`Cash audit close ${String(close.id)} signature chronology or prior-finalization chronology is invalid.`)
      const expectedEntryChecksum = sha256(canonicalJson(covered.map(cashAuditEntryPayload))); const { checksum: _checksum, ...unsignedClose } = cashAuditClosePayload(close); const expectedCloseChecksum = sha256(canonicalJson(unsignedClose))
      if (close.entryChecksum !== expectedEntryChecksum || close.checksum !== expectedCloseChecksum) throw new Error(`Cash audit close ${String(close.id)} checksum does not reconcile.`)
      priorSequence = Number(close.entrySequenceThrough); priorCounted = Number(close.countedBalanceCents); priorDate = String(close.businessDate); priorFinalization = Math.max(Date.parse(String(close.signedAt)), Date.parse(String(close.approvedAt)))
    }
    if (bookCloses.length && bookEntries.some(entry => Number(entry.sequence) > priorSequence && String(entry.businessDate) <= priorDate)) throw new Error(`Cash audit entries for ${bookId} after the final close cannot target an already closed business date.`)
    const postingGroups = new Map<unknown, ExportRow[]>()
    for (const entry of bookEntries) postingGroups.set(entry.journalEntryId, [...(postingGroups.get(entry.journalEntryId) ?? []), entry])
    for (const [journalEntryId, grouped] of postingGroups) {
      const first = grouped[0]
      if (grouped.some(entry => entry.businessDate !== first.businessDate || entry.fiscalYearId !== first.fiscalYearId || entry.tenantId !== first.tenantId)) throw new Error('Cash audit entries sharing a journal reference must share tenant, fiscal year and business date.')
      const expectedAmountCents = grouped.reduce((sum, entry) => { if (entry.type === 'RECEIPT') return addCents(sum, Number(entry.amountCents)); if (entry.type === 'PAYMENT') return addCents(sum, -Number(entry.amountCents)); const original = bookEntries.find(value => value.id === entry.correctsEntryId)!; return addCents(sum, original.type === 'RECEIPT' ? -Number(entry.amountCents) : Number(entry.amountCents)) }, 0)
      validatePosting(journalEntryId, expectedAmountCents, first.businessDate, first.fiscalYearId, first.tenantId, `Cash audit journal reference ${String(journalEntryId)}`)
    }
  }
}
function canonicalIsoInstant(value: string) { if (!isIsoInstant(value)) throw new Error('Cash audit instant is invalid.'); return new Date(value).toISOString() }
function localDate(instant: string, timeZone: string) { try { const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)); const get = (type: string) => parts.find(part => part.type === type)?.value ?? ''; return `${get('year')}-${get('month')}-${get('day')}` } catch { throw new Error('Cash audit master timezone is invalid.') } }
function validDateOnly(value: string) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00.000Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value }
function requireDenseArray(value: readonly unknown[]) { for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw new Error('Canonical JSON does not support sparse arrays.') }
function hasDenseDataArray(value: unknown): value is unknown[] { if (!Array.isArray(value)) return false; for (let index = 0; index < value.length; index++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) return false } return true }
function captureDenseDataArray(value: unknown): unknown[] | null { if (!hasDenseDataArray(value)) return null; const snapshot: unknown[] = []; for (let index = 0; index < value.length; index++) snapshot.push(Object.getOwnPropertyDescriptor(value, String(index))!.value); return snapshot }
function authenticityPayload(manifest: AuditPackage['manifest']) { return canonicalJson({ format: manifest.format, version: manifest.version, tenantId: manifest.tenantId, purpose: manifest.purpose, packageChecksum: manifest.packageChecksum }) }
function sortValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('Canonical JSON does not support non-finite numbers.'); return value }
  if (value instanceof Date) { if (Number.isNaN(value.getTime())) throw new Error('Canonical JSON does not support invalid dates.'); return { $type: 'Date', $value: value.toISOString() } }
  if (value instanceof Uint8Array) return { $type: 'Uint8Array', $base64: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const descriptor of Reflect.ownKeys(descriptors).map(key => descriptors[key as keyof typeof descriptors])) if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Canonical JSON arrays must use own data properties without accessors.')
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    const length = lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value') ? Number(lengthDescriptor.value) : -1
    const result: unknown[] = []
    for (let index = 0; index < length; index++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Canonical JSON does not support sparse arrays or accessor elements.'); result.push(sortValue(descriptor.value)) }
    return result
  }
  if (value && typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Canonical JSON does not support custom objects.')
    const entries: [string, unknown][] = []
    for (const key of Reflect.ownKeys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('Canonical JSON objects must use own data properties without accessors.'); if (typeof key === 'string' && descriptor.enumerable) entries.push([key, descriptor.value]) }
    entries.sort(([a], [b]) => compareCanonicalText(a, b))
    for (const entry of entries) entry[1] = sortValue(entry[1])
    return Object.prototype.hasOwnProperty.call(value, '$type') ? { $type: 'EscapedObject', $entries: entries } : Object.fromEntries(entries)
  }
  throw new Error(`Canonical JSON does not support ${typeof value} values.`)
}
function reviveCanonical(value: unknown): unknown { if (Array.isArray(value)) return value.map(reviveCanonical); if (!value || typeof value !== 'object') return value; const entries = Object.entries(value); if ('$type' in value) { const tagged = value as Record<string, unknown>; if (tagged.$type === 'Date' && entries.length === 2 && typeof tagged.$value === 'string') { const date = new Date(tagged.$value); if (Number.isNaN(date.getTime()) || date.toISOString() !== tagged.$value) throw new Error('Invalid canonical Date tag.'); return date } if (tagged.$type === 'Uint8Array' && entries.length === 2 && typeof tagged.$base64 === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(tagged.$base64)) return new Uint8Array(Buffer.from(tagged.$base64, 'base64')); if (tagged.$type === 'EscapedObject' && entries.length === 2 && Array.isArray(tagged.$entries) && tagged.$entries.every(pair => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string')) return Object.fromEntries((tagged.$entries as [string, unknown][]).map(([key, nested]) => [key, reviveCanonical(nested)])); throw new Error('Unsupported or malformed canonical value tag.') } return Object.fromEntries(entries.map(([key, nested]) => [key, reviveCanonical(nested)])) }
