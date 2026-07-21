import { createHash } from 'node:crypto'
import { canonicalJson } from '@/core/compliance/auditExport'
import {
  createEBalancePayloadEvidence, createEBalanceSemanticFacts, type EBalanceProfile, type TaxonomyRelease,
} from '@/core/compliance/eBilanzLifecycle'

type FiscalPeriod = { id: string; startsAt: Date; endsAt: Date; status: string }

export function createEBalanceReconciliationChecksum(fiscalYearId: string, kind: string, payload: string) {
  return createHash('sha256').update(canonicalJson({ fiscalYearId, kind, payload })).digest('hex')
}

export function verifyTaxonomyArchive(release: TaxonomyRelease, archive: Uint8Array) {
  if (!(archive instanceof Uint8Array) || archive.byteLength === 0) throw new Error('Official taxonomy archive bytes are required.')
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== release.archiveSha256.toLowerCase()) throw new Error('Official taxonomy archive checksum does not match the registered release.')
  return actual
}

export function deriveAuthoritativeEBalanceProfile(ownerId: string, period: FiscalPeriod, rawProfile: unknown): EBalanceProfile {
  if (!rawProfile || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) throw new Error('An effective authoritative company profile is required.')
  const profile = rawProfile as Record<string, unknown>
  const reporting = profile.eBilanz
  if (!reporting || typeof reporting !== 'object' || Array.isArray(reporting)) throw new Error('The effective company profile requires explicit E-Bilanz reporting facts.')
  const facts = reporting as Record<string, unknown>
  const required = (record: Record<string, unknown>, name: string) => {
    const value = record[name]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Authoritative E-Bilanz profile fact ${name} is required.`)
    return value.trim()
  }
  const boolean = (name: string) => facts[name] === undefined ? undefined : typeof facts[name] === 'boolean' ? facts[name] as boolean : (() => { throw new Error(`Authoritative E-Bilanz profile fact ${name} must be boolean.`) })()
  return {
    tenantId: ownerId,
    companyName: required(profile, 'companyName'), legalForm: required(profile, 'legalForm'), taxNumber: required(profile, 'taxNumber'),
    fiscalPeriodStart: period.startsAt.toISOString().slice(0, 10), fiscalPeriodEnd: period.endsAt.toISOString().slice(0, 10),
    accountingStandard: required(facts, 'accountingStandard') as EBalanceProfile['accountingStandard'],
    incomeStatementMethod: required(facts, 'incomeStatementMethod') as EBalanceProfile['incomeStatementMethod'],
    statementType: required(facts, 'statementType') as EBalanceProfile['statementType'], reportStatus: required(facts, 'reportStatus') as EBalanceProfile['reportStatus'],
    consolidationRange: required(facts, 'consolidationRange') as EBalanceProfile['consolidationRange'], incomeClassification: required(facts, 'incomeClassification'),
    ...(boolean('specialBalanceRequired') === undefined ? {} : { specialBalanceRequired: boolean('specialBalanceRequired') }),
    ...(boolean('supplementaryBalanceRequired') === undefined ? {} : { supplementaryBalanceRequired: boolean('supplementaryBalanceRequired') }),
  }
}

export function canonicalXbrlSerializer() {
  return {
    serialize(payload: Readonly<Record<string, unknown>>) { return `<?xml version="1.0" encoding="UTF-8"?><xbrl xmlns="http://www.xbrl.org/2003/instance">${createEBalanceSemanticFacts(payload)}${createEBalancePayloadEvidence(payload)}</xbrl>` },
    parseRoot(xml: string) { return { wellFormed: /^<\?xml[^>]+><xbrl xmlns="http:\/\/www\.xbrl\.org\/2003\/instance">[^]*<\/xbrl>$/.test(xml), localName: 'xbrl', namespaceUri: 'http://www.xbrl.org/2003/instance' } },
  }
}

export function eBalanceLifecycleReadiness(input: { profile?: EBalanceProfile; taxonomy?: TaxonomyRelease; fiscalYearStatus?: string; facts: readonly unknown[]; reconciliationKinds: readonly string[]; assetScheduleReady: boolean; ericQualified: boolean }) {
  const checks = [
    { code: 'PROFILE', ready: Boolean(input.profile), message: 'Effective authoritative E-Bilanz profile facts are configured.' },
    { code: 'TAXONOMY', ready: Boolean(input.taxonomy), message: 'An effective checksum-verified official taxonomy is registered.' },
    { code: 'LEDGER', ready: input.fiscalYearStatus === 'CLOSED', message: 'The authoritative fiscal ledger is closed.' },
    { code: 'FACTS', ready: input.facts.length > 0, message: 'Canonical account-detail facts were derived from the posted ledger.' },
    { code: 'RECONCILIATION', ready: input.reconciliationKinds.includes('ADJUSTMENT'), message: 'Approved book-to-tax reconciliation evidence is persisted.' },
    { code: 'ASSETS', ready: input.assetScheduleReady, message: 'The durable asset register and schedule are available.' },
    { code: 'ERIC_QUALIFICATION', ready: input.ericQualified, message: 'The configured official ERiC gateway and form version are qualified.' },
  ]
  return { ready: checks.every(check => check.ready), checks }
}

type Readiness = ReturnType<typeof eBalanceLifecycleReadiness>

export function allowUnqualifiedEBalanceDrafts(environment: Record<string, string | undefined> = process.env as Record<string, string | undefined>) {
  return environment.E_BILANZ_ALLOW_UNQUALIFIED_DRAFTS === 'true'
}

export function assertEBalanceDraftReadiness(readiness: Readiness, allowUnqualifiedExternalDraft: boolean) {
  const internalFailures = readiness.checks.filter(check => check.code !== 'ERIC_QUALIFICATION' && !check.ready)
  const externalFailure = readiness.checks.find(check => check.code === 'ERIC_QUALIFICATION' && !check.ready)
  const failures = [...internalFailures, ...(externalFailure && !allowUnqualifiedExternalDraft ? [externalFailure] : [])]
  if (failures.length) throw new Error(`E-Bilanz lifecycle is not ready: ${failures.map(check => check.code).join(', ')}`)
}

export type EBalanceLedgerAccount = {
  id: string
  category: string
  eBilanzPosition: string | null
  active: boolean
  journalLines: ReadonlyArray<{ debitCents: number; creditCents: number }>
}

export function createEBalanceLedgerFacts(accounts: readonly EBalanceLedgerAccount[]) {
  const relevant = accounts.filter(account => account.active || account.journalLines.length > 0)
  const balances = relevant.map(account => ({ account, balance: account.journalLines.reduce((sum, line) => sum + line.debitCents - line.creditCents, 0) }))
  const unmapped = balances.filter(({ account, balance }) => !account.eBilanzPosition && balance !== 0)
  if (unmapped.length) throw new Error(`Every nonzero ledger balance requires an E-Bilanz mapping: ${unmapped.map(({ account }) => account.id).join(', ')}`)
  const grouped = new Map<string, { amountCents: number; accountIds: string[] }>()
  for (const { account, balance } of balances) {
    if (!account.eBilanzPosition) continue
    const current = grouped.get(account.eBilanzPosition) ?? { amountCents: 0, accountIds: [] }
    current.amountCents += balance; current.accountIds.push(account.id); grouped.set(account.eBilanzPosition, current)
  }
  if (!grouped.has('is.netIncome')) {
    const pnl = balances.filter(({ account }) => ['REVENUE', 'INCOME', 'EXPENSE'].includes(account.category))
    grouped.set('is.netIncome', { amountCents: pnl.reduce((sum, item) => sum - item.balance, 0), accountIds: pnl.map(item => item.account.id) })
  }
  return [...grouped].map(([concept, value]) => ({ concept, context: concept.startsWith('bs.') ? 'instant' as const : 'duration' as const, amountCents: value.amountCents, unit: 'EUR' as const, accountIds: value.accountIds }))
}

export function taxonomyArchiveStorageKey(release: Pick<TaxonomyRelease, 'version' | 'archiveSha256'>, registrationId: string) {
  if (!registrationId.trim()) throw new Error('Taxonomy archive registration ID is required.')
  return `taxonomies/official/${encodeURIComponent(release.version)}-${release.archiveSha256}-${encodeURIComponent(registrationId)}.zip`
}
