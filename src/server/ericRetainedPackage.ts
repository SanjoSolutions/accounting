import { unzipSync } from 'fflate'
import { canonicalJson } from '@/core/compliance/auditExport'
import { eBalanceChecksum, type EBalanceExportDataset } from '@/core/eBilanzExport'
import { serializeEBalanceFilingXml } from '@/core/eBilanzFilingXml'
import { OFFICIAL_E_BALANCE_TAXONOMIES } from '@/core/eBilanzTaxonomy'
import { parseEBalanceXml, XMLNS } from '@/core/eBilanzXml'

export const ERIC_SCHEMA_TRANSFORM = 'ZIP_RELATIVE_TO_OFFICIAL_SCHEMA_URLS_V1'
export const ERIC_NEGATIVE_MUTATION = 'BS_ASS_INVALID_DECIMAL_V1'
const MAX_MEMBER_BYTES = 60 * 1024 * 1024

/** The expected digest must come from the retained export record, not the ZIP itself.
 * This verifies consistency, not the provenance of a caller-supplied digest. */
export function verifyEricRetainedPackage(archive: Uint8Array, expectedArchiveSha256: string, taxonomyArchive: Uint8Array) {
  if (!/^[a-f0-9]{64}$/.test(expectedArchiveSha256) || eBalanceChecksum(archive) !== expectedArchiveSha256) throw new Error('Retained export archive checksum mismatch.')
  const supportedRelease = OFFICIAL_E_BALANCE_TAXONOMIES.find(release => release.version === '6.9')!
  if (eBalanceChecksum(taxonomyArchive) !== supportedRelease.archiveSha256) throw new Error('The supplied taxonomy archive differs from the official pin.')
  const officialFiles = unzipSync(taxonomyArchive)
  let expandedBytes = 0
  const files = unzipSync(archive, { filter: file => {
    expandedBytes += file.originalSize
    if (file.originalSize > MAX_MEMBER_BYTES || expandedBytes > 256 * 1024 * 1024) throw new Error('Retained export exceeds the qualification limit.')
    if (!Object.hasOwn(officialFiles, file.name) && !['export-data.json', 'local-validation.json', 'manifest.json'].includes(file.name)
      && !/^e-bilanz-\d{4}\.xbrl$/.test(file.name)) throw new Error('Unexpected member in the retained XBRL package.')
    return true
  } })
  for (const [name, bytes] of Object.entries(officialFiles)) {
    if (!files[name] || eBalanceChecksum(files[name]) !== eBalanceChecksum(bytes)) throw new Error('Packaged taxonomy members differ from the official archive.')
  }
  const text = (name: string) => {
    if (!files[name]) throw new Error('Retained export companion is missing.')
    return new TextDecoder('utf-8', { fatal: true }).decode(files[name])
  }
  const dataset = JSON.parse(text('export-data.json')) as EBalanceExportDataset
  if (dataset?.schemaVersion !== 'EBILANZ_EXPORT_V1' || !dataset.closeGenerationId || !dataset.reconciliation?.checksum) throw new Error('An app-generated export dataset is required.')
  for (const date of [dataset.fiscalYear?.startsAt, dataset.fiscalYear?.endsAt]) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
      || new Date(date).toISOString().slice(0, 10) !== date) throw new Error('The retained fiscal period requires canonical dates.')
  }
  if (!Number.isSafeInteger(dataset.fiscalYear.year) || !/^[a-f0-9]{64}$/.test(dataset.reconciliation.checksum)) throw new Error('Retained period and reconciliation identity are invalid.')
  const release = OFFICIAL_E_BALANCE_TAXONOMIES.find(release => release.version === dataset.taxonomy?.version)
  if (!release || release.version !== '6.9' || canonicalJson(dataset.taxonomy) !== canonicalJson(release)
    || eBalanceChecksum(taxonomyArchive) !== release.archiveSha256) throw new Error('The retained taxonomy does not match the pinned Bilanz_6.9 archive.')
  const instanceNames = Object.keys(files).filter(name => name.endsWith('.xbrl'))
  const instanceName = `e-bilanz-${dataset.fiscalYear.year}.xbrl`
  if (instanceNames.length !== 1 || instanceNames[0] !== instanceName) throw new Error('Exactly one fiscal-year XBRL instance is required.')
  const exportXbrl = text(instanceName)
  const exportXbrlSha256 = eBalanceChecksum(files[instanceName])
  const datasetSha256 = eBalanceChecksum(canonicalJson(dataset))
  // Re-serialization is a comparison only: the retained bytes are the input.
  if (exportXbrl !== serializeEBalanceFilingXml(dataset)) throw new Error('Retained XBRL differs from the current app serializer and dataset.')
  const diagnostics = JSON.parse(text('local-validation.json'))
  if (diagnostics?.level !== 'LOCAL_STRUCTURAL' || diagnostics.valid !== true || diagnostics.reportChecksum !== exportXbrlSha256) throw new Error('Retained local validation does not identify these XBRL bytes.')
  if (files['manifest.json']) {
    const manifest = JSON.parse(text('manifest.json'))
    if (manifest?.format !== 'EBILANZ_EXPORT_V1' || manifest.closeGenerationId !== dataset.closeGenerationId
      || manifest.datasetChecksum !== datasetSha256 || manifest.reportChecksum !== exportXbrlSha256
      || manifest.reconciliationChecksum !== dataset.reconciliation.checksum || manifest.taxonomyArchiveSha256 !== release.archiveSha256) throw new Error('Retained export manifest does not match its members.')
  }
  // Change only the two schemaRef hrefs; all facts, contexts, units and whitespace stay intact.
  let ericXbrl = exportXbrl
  for (const [entry, namespace] of [[release.entryPoint, release.gaapNamespace], [release.gcdEntryPoint, release.gcdNamespace]]) {
    ericXbrl = ericXbrl.replace(`xlink:href="${entry}"`, `xlink:href="${namespace}/${entry.split('/').at(-1)}"`)
  }
  if (ericXbrl !== serializeEBalanceFilingXml(dataset, true)) throw new Error('Schema reference transformation changed more than the permitted references.')
  const root = parseEBalanceXml(ericXbrl)
  if (root.uri !== XMLNS.xbrli || root.local !== 'xbrl') throw new Error('The retained instance is not XBRL.')
  const needle = /(<de-gaap-ci:bs\.ass contextRef="instant" unitRef="EUR" decimals="2">)-?\d+\.\d{2}(<\/de-gaap-ci:bs\.ass>)/g
  if ([...ericXbrl.matchAll(needle)].length !== 1) throw new Error('The negative contract requires exactly one numeric total-assets fact.')
  const invalidXbrl = ericXbrl.replace(needle, '$1INVALID_DECIMAL$2')
  return {
    dataset, exportXbrl, ericXbrl, invalidXbrl,
    binding: { archiveSha256: expectedArchiveSha256, datasetSha256, exportXbrlSha256, ericXbrlSha256: eBalanceChecksum(ericXbrl),
      invalidXbrlSha256: eBalanceChecksum(invalidXbrl), taxonomyArchiveSha256: release.archiveSha256,
      closeGenerationSha256: eBalanceChecksum(dataset.closeGenerationId), reconciliationSha256: dataset.reconciliation.checksum,
      fiscalYearStart: dataset.fiscalYear.startsAt, fiscalYearEnd: dataset.fiscalYear.endsAt,
      schemaReferenceTransform: ERIC_SCHEMA_TRANSFORM, negativeMutation: ERIC_NEGATIVE_MUTATION },
  }
}
