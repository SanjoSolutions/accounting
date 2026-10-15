import { readFile, realpath } from 'node:fs/promises'
import path from 'node:path'
import { strFromU8, unzipSync } from 'fflate'
import { canonicalJson } from '../../core/compliance/auditExport'
import { ANNUAL_DOCUMENT_RENDERER, annualDocumentFiles, hashDocument, readAnnualDocumentInput, type AnnualDocumentSource } from '../../core/compliance/annualDocuments'
import { qualifiedDisclosureCases, type QualifiedDisclosureCase } from './disclosureQualificationContract'

interface PinnedFile { file: string; sha256: string }
export interface DisclosureQualificationFixture {
  disclosureCase: QualifiedDisclosureCase
  annualBundle: PinnedFile
  manualBundle: PinnedFile
  validPayload: PinnedFile
  invalidPayload: PinnedFile
}
export interface DisclosureQualificationManifest {
  format: 'disclosure-qualification-inputs-1'
  gatewayId: string
  qualificationId: string
  schemaVersion: string
  environment: 'TEST' | 'STAGING'
  adapterVersion: string
  review: { syntheticDataOnly: true; nonBinding: true; mappingApproved: true }
  cases: DisclosureQualificationFixture[]
}

const digest = /^[a-f0-9]{64}$/
const fail = () => new Error('Disclosure qualification inputs are missing, changed, or not bound to reviewed app exports.')

async function pinnedFile(directory: string, entry: PinnedFile) {
  if (!entry || typeof entry.file !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.file) || !digest.test(entry.sha256)) throw fail()
  const target = await realpath(path.join(directory, entry.file))
  if (path.dirname(target) !== directory) throw fail()
  const bytes = await readFile(target)
  if (!bytes.length || hashDocument(bytes) !== entry.sha256) throw fail()
  return bytes
}

function readBundle(bytes: Uint8Array, mode: 'annual' | 'manual') {
  const files = unzipSync(bytes)
  const names = mode === 'annual' ? ['abschluss.json', 'jahresabschluss.html'] : ['ANLEITUNG.txt', 'einreichung.html']
  if (Object.keys(files).sort().join(',') !== [...names, 'manifest.json'].sort().join(',')) throw fail()
  const manifest = JSON.parse(strFromU8(files['manifest.json']))
  if (manifest.format !== ANNUAL_DOCUMENT_RENDERER || manifest.mode !== mode || manifest.status !== 'EXPORTED_NOT_FILED') throw fail()
  if (Object.keys(manifest.files).sort().join(',') !== names.sort().join(',')) throw fail()
  for (const name of names) if (hashDocument(files[name]) !== manifest.files[name]?.sha256 || files[name].byteLength !== manifest.files[name]?.bytes) throw fail()
  return { manifest, files }
}

/** Pinned review attests provenance and provider mapping; hashes alone cannot establish either. */
export async function loadDisclosureQualificationPackages(directory: string, manifestSha256: string, expected: Pick<DisclosureQualificationManifest, 'gatewayId' | 'qualificationId' | 'schemaVersion' | 'environment'>) {
  const root = await realpath(directory)
  const manifestBytes = await pinnedFile(root, { file: 'manifest.json', sha256: manifestSha256 })
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as DisclosureQualificationManifest
  if (manifest.format !== 'disclosure-qualification-inputs-1' || typeof manifest.adapterVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(manifest.adapterVersion)) throw fail()
  for (const key of ['gatewayId', 'qualificationId', 'schemaVersion', 'environment'] as const) if (manifest[key] !== expected[key]) throw fail()
  if (!['TEST', 'STAGING'].includes(manifest.environment) || manifest.review?.syntheticDataOnly !== true || manifest.review?.nonBinding !== true || manifest.review?.mappingApproved !== true) throw fail()
  if (!Array.isArray(manifest.cases) || manifest.cases.length !== 2 || manifest.cases.map(item => item.disclosureCase).sort().join(',') !== [...qualifiedDisclosureCases].sort().join(',')) throw fail()

  return Promise.all(manifest.cases.map(async entry => {
    const [annualBytes, manualBytes, validPayload, invalidPayload] = await Promise.all([
      pinnedFile(root, entry.annualBundle), pinnedFile(root, entry.manualBundle), pinnedFile(root, entry.validPayload), pinnedFile(root, entry.invalidPayload),
    ])
    if (entry.validPayload.sha256 === entry.invalidPayload.sha256) throw fail()
    const annual = readBundle(annualBytes, 'annual'); const manual = readBundle(manualBytes, 'manual')
    const source = JSON.parse(strFromU8(annual.files['abschluss.json'])) as AnnualDocumentSource
    const input = readAnnualDocumentInput(source.annual)
    if (typeof source.packageId !== 'string' || !source.packageId.trim() || typeof source.approvedBy !== 'string' || !source.approvedBy.trim() || typeof source.approvedAt !== 'string' || !Number.isFinite(Date.parse(source.approvedAt)) || !digest.test(source.close.checksum)) throw fail()
    if (canonicalJson(source.input) !== canonicalJson(input) || source.packageVersion !== source.annual.version || !digest.test(source.packageChecksum)) throw fail()
    if ((input.profile.size === 'MICRO' ? 'MICRO-HINTERLEGUNG' : input.profile.size === 'SMALL' ? 'SMALL-OFFENLEGUNG' : '') !== entry.disclosureCase) throw fail()
    for (const bundle of [annual, manual]) {
      const metadata = bundle.manifest
      if (metadata.sourcePackageId !== source.packageId || metadata.sourceVersion !== source.packageVersion || metadata.sourceChecksum !== source.packageChecksum || metadata.sourceCloseId !== source.close.id || metadata.sourceCloseChecksum !== source.close.checksum || metadata.approval?.by !== source.approvedBy || metadata.approval?.at !== source.approvedAt) throw fail()
    }
    if (manual.manifest.review !== 'USER_CONFIRMED_COMPLETE_AND_MINIMIZED') throw fail()
    // Reuse the app's selection and renderer: never transmit the private companion or GuV.
    const regenerated = annualDocumentFiles(source, 'manual', manual.manifest.disclosureSelection)
    for (const [name, content] of Object.entries(regenerated)) if (content !== strFromU8(manual.files[name])) throw fail()
    return {
      disclosureCase: entry.disclosureCase, fiscalYear: input.fiscalYear,
      sourcePackageChecksum: source.packageChecksum, annualBundleSha256: entry.annualBundle.sha256,
      manualBundleSha256: entry.manualBundle.sha256, manifestSha256, adapterVersion: manifest.adapterVersion,
      validPayload, invalidPayload,
    }
  }))
}

export type DisclosureQualificationPackage = Awaited<ReturnType<typeof loadDisclosureQualificationPackages>>[number]

export function disclosureQualificationRequest(pkg: DisclosureQualificationPackage, config: { environment: 'TEST' | 'STAGING'; schemaVersion: string; submitterId: string; qualificationId: string }, invalid = false) {
  const bytes = invalid ? pkg.invalidPayload : pkg.validPayload
  return {
    destination: 'UNTERNEHMENSREGISTER', environment: config.environment, nonBinding: true,
    disclosureCase: pkg.disclosureCase, fiscalYear: pkg.fiscalYear, schemaVersion: config.schemaVersion,
    submitterId: config.submitterId, qualificationId: config.qualificationId,
    sourcePackageChecksum: pkg.sourcePackageChecksum, manualBundleSha256: pkg.manualBundleSha256,
    adapterVersion: pkg.adapterVersion, packageSha256: hashDocument(bytes),
    payload: { encoding: 'base64', content: bytes.toString('base64') },
  }
}

export function disclosureSubmissionKey(request: ReturnType<typeof disclosureQualificationRequest>) {
  return hashDocument(canonicalJson(request))
}
