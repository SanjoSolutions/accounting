import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { declarationDatasetHash, taxFormRegistry, type DeclarationDataset } from '../../core/taxDeclarations'
import { qualifiedContractFormVersions, type QualifiedGatewayContractConfig } from './qualificationContract'

export const qualificationSha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export interface QualifiedTaxArtifact {
  dataset: DeclarationDataset
  binding: { bundleSha256: string; preparationIdSha256: string; datasetSha256: string }
}

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const invalid = () => new Error('The reviewed artifact bundle must contain exactly one retained application preparation for each supported form version and the authorized test taxpayer.')

// The separately reviewed digest is the trust anchor. A JSON provenance claim or
// a hash computed from an arbitrary input file does not authenticate app origin.
export function parseQualifiedTaxArtifacts(bytes: Buffer, config: Pick<QualifiedGatewayContractConfig, 'artifactBundleSha256' | 'environment' | 'taxpayerId'>): QualifiedTaxArtifact[] {
  if (bytes.length > 5 * 1024 * 1024 || !config.artifactBundleSha256 || qualificationSha256(bytes) !== config.artifactBundleSha256) throw new Error('The retained application artifact bundle does not match its reviewed SHA-256 or size limit.')
  let bundle: unknown
  try { bundle = JSON.parse(bytes.toString('utf8')) } catch { throw invalid() }
  if (!record(bundle) || bundle.schema !== 'qualified-tax-gateway-artifacts' || bundle.version !== 1 || !['TEST', 'STAGING'].includes(String(bundle.environment)) || bundle.environment !== config.environment || !Array.isArray(bundle.artifacts) || bundle.artifacts.length !== qualifiedContractFormVersions.length) throw invalid()
  const versions = new Set<string>()
  const preparations = new Set<string>()
  const artifacts = bundle.artifacts.map((entry: unknown) => {
    if (!record(entry) || typeof entry.preparationId !== 'string' || !entry.preparationId.trim() || entry.preparationId.length > 256 || preparations.has(entry.preparationId) || !record(entry.dataset)) throw invalid()
    const dataset = entry.dataset
    if (typeof dataset.kind !== 'string' || typeof dataset.period !== 'string' || typeof dataset.formVersion !== 'string' || !qualifiedContractFormVersions.includes(dataset.formVersion as typeof qualifiedContractFormVersions[number]) || versions.has(dataset.formVersion) || !config.taxpayerId || dataset.taxpayerId !== config.taxpayerId || !record(dataset.fields) || !record(dataset.drilldown)) throw invalid()
    if (Object.values(dataset.fields).some(value => !['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isSafeInteger(value))) throw invalid()
    let prepared: DeclarationDataset
    try {
      prepared = taxFormRegistry.prepare(dataset.kind as DeclarationDataset['kind'], dataset.period, dataset.fields as DeclarationDataset['fields'], dataset.drilldown as DeclarationDataset['drilldown'], config.taxpayerId)
      if (prepared.formVersion !== dataset.formVersion || declarationDatasetHash(prepared) !== entry.datasetSha256 || declarationDatasetHash(dataset as unknown as DeclarationDataset) !== entry.datasetSha256) throw invalid()
    } catch { throw invalid() }
    versions.add(dataset.formVersion)
    preparations.add(entry.preparationId)
    return { dataset: prepared, binding: { bundleSha256: config.artifactBundleSha256!, preparationIdSha256: qualificationSha256(entry.preparationId), datasetSha256: String(entry.datasetSha256) } }
  })
  return qualifiedContractFormVersions.map(version => artifacts.find(artifact => artifact.dataset.formVersion === version)!)
}

export function loadQualifiedTaxArtifacts(config: QualifiedGatewayContractConfig): QualifiedTaxArtifact[] {
  if (!config.enabled) return []
  if (!config.artifactBundlePath) throw new Error('A reviewed retained application artifact bundle is required.')
  try {
    if (!statSync(config.artifactBundlePath).isFile() || statSync(config.artifactBundlePath).size > 5 * 1024 * 1024) throw invalid()
    return parseQualifiedTaxArtifacts(readFileSync(config.artifactBundlePath), config)
  } catch {
    // Do not include paths, JSON parser excerpts or taxpayer payloads in reports.
    throw new Error('Cannot load the reviewed retained application artifact bundle; verify its digest, provenance, environment, taxpayer and eight form versions.')
  }
}

export function qualificationSubmissionKey(artifact: QualifiedTaxArtifact, config: Pick<QualifiedGatewayContractConfig, 'gatewayId' | 'qualificationId' | 'environment'>) {
  return qualificationSha256(JSON.stringify(['qualified-tax-contract-v2', config.gatewayId, config.qualificationId, config.environment, artifact.binding.preparationIdSha256, artifact.binding.datasetSha256]))
}
