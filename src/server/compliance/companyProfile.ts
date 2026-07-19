export type LegalForm = 'SOLE_TRADER' | 'GMBH' | 'UG' | 'AG' | 'OHG' | 'KG' | 'GBR' | 'PARTNERSHIP' | 'OTHER'
export type VatRegime = 'STANDARD' | 'SMALL_BUSINESS' | 'EXEMPT'
export type FilingFrequency = 'MONTHLY' | 'QUARTERLY' | 'ANNUAL'

export interface CompanyProfile {
  companyName: string
  registeredAddress?: { streetAndHouseNumber: string; zipCode: string; city: string; country: string }
  legalForm: LegalForm
  registerCourt?: string
  registerNumber?: string
  taxNumber: string
  vatId?: string
  taxOffice: string
  vatRegime: VatRegime
  vatFilingFrequency: FilingFrequency
  activity: string
  sizeClass: 'MICRO' | 'SMALL' | 'MEDIUM' | 'LARGE'
  chart: 'SKR03' | 'SKR04' | `CUSTOM:${string}`
  elections: string[]
  applicabilityOverrides?: Partial<Record<ReportKind, boolean>>
}

export type ReportKind = 'VAT_ADVANCE' | 'VAT_ANNUAL' | 'E_BILANZ' | 'HGB_FINANCIAL_STATEMENTS'
export interface ProfileVersion { id: string; ownerId: string; effectiveFrom: string; effectiveTo?: string; profile: CompanyProfile; actorId: string; reason: string }

const isoDate = /^\d{4}-\d{2}-\d{2}$/
const isRealIsoDate = (value: string) => { if (!isoDate.test(value)) return false; const date = new Date(`${value}T00:00:00.000Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value }
export class CompanyProfileValidationError extends TypeError {}
export const validateEffectiveDate = (value: unknown) => typeof value === 'string' && isRealIsoDate(value) ? [] : ['Effective date must be a real YYYY-MM-DD date']
export function allocateProfileEffectiveInstant(effectiveFrom: string, existing: Date[]): Date | null {
  const start = new Date(`${effectiveFrom}T00:00:00.000Z`)
  if (!isRealIsoDate(effectiveFrom)) return null
  const nextDay = new Date(start.getTime() + 86_400_000)
  const latest = [...existing].sort((left, right) => right.getTime() - left.getTime())[0]
  const candidate = latest ? new Date(latest.getTime() + 1) : start
  return candidate < nextDay ? candidate : null
}
export function validateChartActivation(profileChart: unknown, activeChart: string, importedCharts: string[] = []): string[] {
  if (typeof profileChart === 'string' && profileChart.startsWith('CUSTOM:') && profileChart !== activeChart && !importedCharts.includes(profileChart)) return ['Custom chart must be imported and atomically activated before it can become authoritative']
  return []
}
export function validateChartConsistency(requestedChart: unknown, authoritativeChart: string | undefined): string[] {
  return requestedChart !== undefined && authoritativeChart !== undefined && requestedChart !== authoritativeChart ? ['Chart-only update would contradict the authoritative company profile'] : []
}
export function validateAtomicChartTransition(requestedChart: unknown, replacementProfileChart: unknown, storedProfileChart: string | undefined): string[] {
  if (replacementProfileChart !== undefined) return requestedChart !== undefined && requestedChart !== replacementProfileChart ? ['Chart and replacement company profile must activate the same chart'] : []
  return validateChartConsistency(requestedChart, storedProfileChart)
}
export function validateLiveEffectiveDate(effectiveFrom: unknown, today = new Date().toISOString().slice(0, 10)): string[] {
  return effectiveFrom === today ? [] : ['Live company profile transitions must use today as effective date; schedule future versions separately']
}
const canonicalJson = (value: unknown): string => {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : `{"$number":${JSON.stringify(String(value))}}`
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value && typeof value === 'object') return Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]` : `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  throw new TypeError('Company profile contains a non-JSON value')
}
export function profilesSemanticallyEqual(left: unknown, right: unknown) { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
export function mergeDefinedFields<T extends object>(target: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new CompanyProfileValidationError('Settings section must be an object')
  for (const [key, value] of Object.entries(patch)) if (value !== undefined) (target as Record<string, unknown>)[key] = value
  return target
}
const invoiceIssuerFields = ['name', 'streetAndHouseNumber', 'zipCode', 'city', 'country'] as const
type InvoiceIssuerField = typeof invoiceIssuerFields[number]
export function mergeInvoiceIssuerFields<T extends Record<InvoiceIssuerField, string>>(target: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new CompanyProfileValidationError('Settings section must be an object')
  const source = patch as Record<string, unknown>
  for (const field of invoiceIssuerFields) {
    if (!Object.prototype.hasOwnProperty.call(source, field) || source[field] === undefined) continue
    if (typeof source[field] !== 'string') throw new CompanyProfileValidationError(`invoiceIssuer.${field} must be a string`)
    target[field] = source[field]
  }
  return target
}
export function validateSettingsSnapshot(expectedPayload: string, currentPayload: string) { if (expectedPayload !== currentPayload) throw new CompanyProfileValidationError('Settings changed concurrently; reload before saving') }
export function isIdempotentProfileRetry(existing: { payload: string; createdBy: string; reason: string }, candidate: { payload: string; createdBy: string; reason: string }) {
  try { return canonicalJson(JSON.parse(existing.payload)) === canonicalJson(JSON.parse(candidate.payload)) && existing.createdBy === candidate.createdBy && existing.reason === candidate.reason } catch { return false }
}
export function isLatestIdempotentProfileRetry(existingNewestFirst: Array<{ payload: string; createdBy: string; reason: string }>, candidate: { payload: string; createdBy: string; reason: string }) {
  return Boolean(existingNewestFirst[0] && isIdempotentProfileRetry(existingNewestFirst[0], candidate))
}
export function validateCompanyProfile(profile: unknown): string[] {
  const issues: string[] = []
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return ['company profile must be an object']
  const value = profile as Partial<CompanyProfile>
  for (const [label, field] of [['companyName', value.companyName], ['taxNumber', value.taxNumber], ['taxOffice', value.taxOffice], ['activity', value.activity]] as const) {
    if (typeof field !== 'string' || !field.trim()) issues.push(`${label} is required`)
  }
  const courtValid = value.registerCourt === undefined || typeof value.registerCourt === 'string' && Boolean(value.registerCourt.trim())
  const numberValid = value.registerNumber === undefined || typeof value.registerNumber === 'string' && Boolean(value.registerNumber.trim())
  if (!courtValid) issues.push('registerCourt must be a nonempty string')
  if (!numberValid) issues.push('registerNumber must be a nonempty string')
  if ((value.registerCourt === undefined) !== (value.registerNumber === undefined)) issues.push('registerCourt and registerNumber must be supplied together')
  if (typeof value.taxNumber !== 'string' || !/^[A-Z0-9:/ -]{8,20}$/i.test(value.taxNumber)) issues.push('taxNumber has an invalid format')
  if (value.vatId !== undefined && (typeof value.vatId !== 'string' || !/^DE\d{9}$/.test(value.vatId))) issues.push('vatId must be a German VAT ID')
  if (!['SOLE_TRADER', 'GMBH', 'UG', 'AG', 'OHG', 'KG', 'GBR', 'PARTNERSHIP', 'OTHER'].includes(value.legalForm ?? '')) issues.push('legalForm is invalid')
  if (!['STANDARD', 'SMALL_BUSINESS', 'EXEMPT'].includes(value.vatRegime ?? '')) issues.push('vatRegime is invalid')
  if (!['MONTHLY', 'QUARTERLY', 'ANNUAL'].includes(value.vatFilingFrequency ?? '')) issues.push('vatFilingFrequency is invalid')
  if (!['MICRO', 'SMALL', 'MEDIUM', 'LARGE'].includes(value.sizeClass ?? '')) issues.push('sizeClass is invalid')
  if (value.registeredAddress !== undefined) {
    if (!value.registeredAddress || typeof value.registeredAddress !== 'object' || Array.isArray(value.registeredAddress)) issues.push('registeredAddress is invalid')
    else for (const field of ['streetAndHouseNumber', 'zipCode', 'city', 'country'] as const) if (typeof value.registeredAddress[field] !== 'string' || !value.registeredAddress[field].trim()) issues.push(`registeredAddress.${field} is required`)
  }
  if (typeof value.chart !== 'string' || !['SKR03', 'SKR04'].includes(value.chart) && !/^CUSTOM:.+/.test(value.chart)) issues.push('chart is invalid')
  if (!Array.isArray(value.elections) || value.elections.some(item => typeof item !== 'string')) issues.push('elections must be a string array')
  if (value.applicabilityOverrides !== undefined && (!value.applicabilityOverrides || typeof value.applicabilityOverrides !== 'object' || Array.isArray(value.applicabilityOverrides) || Object.entries(value.applicabilityOverrides).some(([key, item]) => !['VAT_ADVANCE', 'VAT_ANNUAL', 'E_BILANZ', 'HGB_FINANCIAL_STATEMENTS'].includes(key) || typeof item !== 'boolean'))) issues.push('applicabilityOverrides is invalid')
  return issues
}

export function upgradeProfileRegisteredAddress(profile: unknown, invoiceIssuer: unknown): unknown {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return profile
  const upgraded = structuredClone(profile) as Record<string, unknown>
  if (upgraded.registeredAddress !== undefined || !invoiceIssuer || typeof invoiceIssuer !== 'object' || Array.isArray(invoiceIssuer)) return upgraded
  const issuer = invoiceIssuer as Record<string, unknown>
  const fields = ['streetAndHouseNumber', 'zipCode', 'city', 'country'] as const
  if (fields.every(field => typeof issuer[field] === 'string' && Boolean((issuer[field] as string).trim()))) {
    upgraded.registeredAddress = Object.fromEntries(fields.map(field => [field, (issuer[field] as string).trim()]))
  }
  return upgraded
}

export function validateVersionedCompanyProfile(profile: unknown): string[] {
  const issues = validateCompanyProfile(profile)
  if (profile && typeof profile === 'object' && !Array.isArray(profile) && (profile as Partial<CompanyProfile>).registeredAddress === undefined) issues.push('registeredAddress is required for an authoritative profile version')
  return issues
}

export function legacyProfileBaseline(profile: unknown, invoiceIssuer: unknown): { effectiveFrom: string; profile: unknown } | undefined {
  if (profile === undefined) return undefined
  // Preserve only address evidence that existed in the legacy record. An
  // incomplete baseline remains report-blocking until the explicit immutable
  // historical-address confirmation workflow records supporting evidence.
  return { effectiveFrom: '1900-01-01', profile: upgradeProfileRegisteredAddress(profile, invoiceIssuer) }
}

export function profilePayloadWithConfirmedAddress(profilePayload: string, confirmationPayload: string | undefined): string {
  const profile = JSON.parse(profilePayload) as Record<string, unknown>
  if (profile.registeredAddress !== undefined || !confirmationPayload) return profilePayload
  const confirmed = JSON.parse(confirmationPayload) as unknown
  const upgraded = upgradeProfileRegisteredAddress(profile, confirmed)
  const issues = validateVersionedCompanyProfile(upgraded)
  if (issues.length) throw new CompanyProfileValidationError(`Historical profile address confirmation is invalid: ${issues.join('; ')}`)
  return JSON.stringify(upgraded)
}

export function validateProfileVersions(versions: ProfileVersion[]): string[] {
  const issues: string[] = []
  const byOwner = Map.groupBy(versions, item => item.ownerId)
  for (const ownerVersions of byOwner.values()) {
    const sorted = [...ownerVersions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
    sorted.forEach((version, index) => {
      if (!isRealIsoDate(version.effectiveFrom) || version.effectiveTo && !isRealIsoDate(version.effectiveTo)) issues.push('profile dates must be real YYYY-MM-DD dates')
      if (version.effectiveTo && version.effectiveTo < version.effectiveFrom) issues.push('profile effective range is invalid')
      const next = sorted[index + 1]
      if (next && version.effectiveTo && version.effectiveTo >= next.effectiveFrom) issues.push('profile versions overlap')
    })
  }
  return issues
}

export function profileAt(versions: ProfileVersion[], ownerId: string, date: string): ProfileVersion | undefined {
  return versions.filter(version => version.ownerId === ownerId && version.effectiveFrom <= date && (!version.effectiveTo || version.effectiveTo >= date)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0]
}

export function deriveReportApplicability(profile: CompanyProfile): Record<ReportKind, { applicable: boolean; basis: string; overridden: boolean }> {
  const derived: Record<ReportKind, boolean> = {
    VAT_ADVANCE: profile.vatRegime === 'STANDARD' && profile.vatFilingFrequency !== 'ANNUAL',
    VAT_ANNUAL: profile.vatRegime !== 'EXEMPT',
    E_BILANZ: !profile.elections.includes('E_BILANZ_EXEMPT'),
    HGB_FINANCIAL_STATEMENTS: !['SOLE_TRADER', 'GBR'].includes(profile.legalForm) || profile.sizeClass !== 'MICRO',
  }
  return Object.fromEntries(Object.entries(derived).map(([kind, applicable]) => {
    const override = profile.applicabilityOverrides?.[kind as ReportKind]
    return [kind, { applicable: override ?? applicable, basis: override === undefined ? 'derived from authoritative profile' : 'documented profile override', overridden: override !== undefined }]
  })) as ReturnType<typeof deriveReportApplicability>
}

export function migrateLegacyDefault<T>(legacy: T | undefined, existingOwners: string[]): Map<string, T> {
  if (legacy === undefined) return new Map()
  if (existingOwners.length !== 1) throw new Error('Legacy default can only be assigned when exactly one tenant is known')
  return new Map([[existingOwners[0], legacy]])
}
