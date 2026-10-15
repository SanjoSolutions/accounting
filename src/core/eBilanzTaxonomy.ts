/** Official releases, not a list of locally qualified ERiC gateways. */
export interface OfficialEBalanceTaxonomy {
  version: string
  publishedOn: string
  validFrom: string
  validThrough: string
  gaapNamespace: string
  gcdNamespace: string
  entryPoint: string
  gcdEntryPoint: string
  archiveFile: string
  archiveUrl: string
  archiveSha256: string
  announcedTestFrom: string
  announcedLiveFrom: string
  receiverVerifiedOn: string | null
}

export const OFFICIAL_E_BALANCE_TAXONOMIES: readonly OfficialEBalanceTaxonomy[] = Object.freeze([
  Object.freeze({
    version: '6.9', publishedOn: '2025-06-10', validFrom: '2025-01-01', validThrough: '2026-12-31',
    gaapNamespace: 'http://www.xbrl.de/taxonomies/de-gaap-ci-2025-04-01',
    gcdNamespace: 'http://www.xbrl.de/taxonomies/de-gcd-2025-04-01',
    entryPoint: 'de-gaap-ci-2025-04-01/de-gaap-ci-2025-04-01-shell-fiscal.xsd',
    gcdEntryPoint: 'de-gcd-2025-04-01/de-gcd-2025-04-01-shell.xsd',
    archiveFile: 'german-gaap-taxonomy-v6.9-2025-04-01-xbrl.zip',
    archiveUrl: 'https://www.esteuer.de/download/taxonomie_20250618/german-gaap-taxonomy-v6.9-2025-04-01-xbrl.zip',
    archiveSha256: 'accd62202d73c036910fee118b30730f0392934afc9730617788e30a0480df87',
    announcedTestFrom: '2025-11-01', announcedLiveFrom: '2026-05-01', receiverVerifiedOn: '2026-10-13',
  }),
])

export const ANNOUNCED_E_BALANCE_610 = Object.freeze({
  version: '6.10', publishedOn: '2026-06-08', validFrom: '2026-01-01',
  announcedTestFrom: '2026-11-01', announcedLiveFrom: '2027-05-01',
  receiverVerifiedOn: null,
})

export function selectOfficialEBalanceTaxonomy(
  fiscalPeriodStart: string,
  options: { asOf: string; receiver?: 'TEST' | 'LIVE'; requestedVersion?: string },
  registry = OFFICIAL_E_BALANCE_TAXONOMIES,
) {
  for (const date of [fiscalPeriodStart, options.asOf]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('Taxonomy selection requires real date-only values.')
  }
  const eligible = registry.filter(release => release.validFrom <= fiscalPeriodStart && fiscalPeriodStart <= release.validThrough
    && release.receiverVerifiedOn !== null && release.receiverVerifiedOn <= options.asOf
    && (options.receiver === 'TEST' ? release.announcedTestFrom : release.announcedLiveFrom) <= options.asOf)
  // Prefer the published baseline. A newer version needs an explicit receiver choice.
  const selected = options.requestedVersion ? eligible.find(release => release.version === options.requestedVersion) : eligible[0]
  if (!selected) throw new Error(`No checksum-pinned, receiver-available E-Bilanz taxonomy supports ${fiscalPeriodStart}${options.requestedVersion ? ` (${options.requestedVersion})` : ''}.`)
  return selected
}
