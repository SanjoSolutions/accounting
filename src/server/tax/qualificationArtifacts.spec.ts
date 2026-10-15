import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { declarationDatasetHash } from '../../core/taxDeclarations'
import { qualificationFixtureBundle } from '../../test/qualificationFixtures'
import { loadQualifiedTaxArtifacts, parseQualifiedTaxArtifacts, qualificationSha256, qualificationSubmissionKey } from './qualificationArtifacts'
import { qualifiedContractFormVersions, retainQualificationEvidence } from './qualificationContract'

const config = { environment: 'STAGING' as const, taxpayerId: 'synthetic-authorized-taxpayer' }
const parse = (bundle: unknown) => {
  const bytes = Buffer.from(JSON.stringify(bundle))
  return parseQualifiedTaxArtifacts(bytes, { ...config, artifactBundleSha256: qualificationSha256(bytes) })
}
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('retained application artifact contract', () => {
  test('Given a reviewed matrix, when loaded, then every exact version is bound to its dataset, preparation and bundle digest', () => {
    const bundle = qualificationFixtureBundle()
    const artifacts = parse(bundle)
    expect(artifacts.map(item => item.dataset.formVersion)).toEqual(qualifiedContractFormVersions)
    expect(artifacts[0].binding).toEqual({ bundleSha256: qualificationSha256(JSON.stringify(bundle)), datasetSha256: declarationDatasetHash(bundle.artifacts[0].dataset), preparationIdSha256: qualificationSha256(bundle.artifacts[0].preparationId) })
    expect(Object.isFrozen(artifacts[0].dataset.fields)).toBe(true)
  })

  test('Given a changed bundle or absent pin, when parsed, then no artifact is accepted', () => {
    const bytes = Buffer.from(JSON.stringify(qualificationFixtureBundle()))
    expect(() => parseQualifiedTaxArtifacts(bytes, config)).toThrow(/reviewed SHA-256/)
    expect(() => parseQualifiedTaxArtifacts(Buffer.concat([bytes, Buffer.from(' ')]), { ...config, artifactBundleSha256: qualificationSha256(bytes) })).toThrow(/reviewed SHA-256/)
  })

  test.each(['missing', 'duplicate-version', 'duplicate-preparation', 'wrong-taxpayer', 'wrong-environment', 'wrong-year', 'changed-data', 'wrong-hash', 'extra-data', 'missing-field', 'malformed-field', 'unsupported-version'])(
    'Given %s in a pinned bundle, when loaded, then the entire matrix fails before transport', fault => {
      const bundle = JSON.parse(JSON.stringify(qualificationFixtureBundle()))
      const entry = bundle.artifacts[0]
      if (fault === 'missing') bundle.artifacts.pop()
      if (fault === 'duplicate-version') bundle.artifacts[1] = { ...entry, preparationId: 'different' }
      if (fault === 'duplicate-preparation') bundle.artifacts[1].preparationId = entry.preparationId
      if (fault === 'wrong-taxpayer') entry.dataset.taxpayerId = 'another-taxpayer'
      if (fault === 'wrong-environment') bundle.environment = 'PRODUCTION'
      if (fault === 'wrong-year') entry.dataset.period = '2026-01'
      if (fault === 'changed-data') entry.dataset.fields.ZAHLLAST++
      if (fault === 'wrong-hash') entry.datasetSha256 = 'a'.repeat(64)
      if (fault === 'extra-data') entry.dataset.unreviewed = true
      if (fault === 'missing-field') delete entry.dataset.fields.ZAHLLAST
      if (fault === 'malformed-field') entry.dataset.fields.ZAHLLAST = { amount: 1900 }
      if (fault === 'unsupported-version') entry.dataset.formVersion = 'USTVA-2027.1'
      expect(() => parse(bundle)).toThrow(/exactly one retained application preparation/)
    },
  )

  test('Given malformed or oversized bytes, when parsed, then errors contain no raw payload', () => {
    for (const bytes of [Buffer.from('private-taxpayer: not JSON'), Buffer.alloc(5 * 1024 * 1024 + 1)]) {
      expect(() => parseQualifiedTaxArtifacts(bytes, { ...config, artifactBundleSha256: qualificationSha256(bytes) })).toThrow()
      try { parseQualifiedTaxArtifacts(bytes, { ...config, artifactBundleSha256: qualificationSha256(bytes) }) } catch (error) { expect(String(error)).not.toContain('private-taxpayer') }
    }
  })

  test('Given a retained bundle file, when loaded, then the pin is enforced and disabled contracts read nothing', () => {
    const directory = mkdtempSync(join(tmpdir(), 'qualification-artifacts-')); directories.push(directory)
    const file = join(directory, 'artifacts.json')
    const bytes = Buffer.from(JSON.stringify(qualificationFixtureBundle()))
    writeFileSync(file, bytes)
    expect(loadQualifiedTaxArtifacts({ ...config, enabled: true, allowSubmission: true, qualifiedFormVersions: qualifiedContractFormVersions, artifactBundlePath: file, artifactBundleSha256: qualificationSha256(bytes) })).toHaveLength(8)
    expect(loadQualifiedTaxArtifacts({ enabled: false, allowSubmission: false, qualifiedFormVersions: [], artifactBundlePath: 'nonexistent' })).toEqual([])
    expect(() => loadQualifiedTaxArtifacts({ ...config, enabled: true, allowSubmission: true, qualifiedFormVersions: [], artifactBundlePath: file, artifactBundleSha256: 'a'.repeat(64) })).toThrow(/Cannot load/)
  })

  test('Given retries or a changed qualification identity, when keys are derived, then only the same artifact and scope reuse the key', () => {
    const artifact = parse(qualificationFixtureBundle())[0]
    const scope = { gatewayId: 'gateway-1', qualificationId: 'qualification-1', environment: 'STAGING' as const }
    const key = qualificationSubmissionKey(artifact, scope)
    expect(qualificationSubmissionKey(artifact, scope)).toBe(key)
    for (const changed of [{ gatewayId: 'gateway-2' }, { qualificationId: 'qualification-2' }, { environment: 'TEST' as const }]) expect(qualificationSubmissionKey(artifact, { ...scope, ...changed })).not.toBe(key)
    expect(qualificationSubmissionKey({ ...artifact, binding: { ...artifact.binding, datasetSha256: 'b'.repeat(64) } }, scope)).not.toBe(key)
    expect(qualificationSubmissionKey({ ...artifact, binding: { ...artifact.binding, preparationIdSha256: 'b'.repeat(64) } }, scope)).not.toBe(key)
  })

  test('Given retained evidence, when the filename is reused or escapes its directory, then the original remains unchanged', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'qualification-evidence-')); directories.push(directory)
    const file = await retainQualificationEvidence(directory, 'protocol.json', { accepted: true })
    await expect(retainQualificationEvidence(directory, 'protocol.json', { accepted: false })).rejects.toThrow()
    await expect(retainQualificationEvidence(directory, '../outside.json', {})).rejects.toThrow(/filename/)
    expect(JSON.parse(readFileSync(file, 'utf8')).accepted).toBe(true)
  })
})
