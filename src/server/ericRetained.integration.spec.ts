import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { OFFICIAL_E_BALANCE_TAXONOMIES } from '@/core/eBilanzTaxonomy'
import { retainedEricConfiguration, runRetainedEricQualification, type EricRetainedQualificationManifest } from './ericRetainedQualification'

const configuration = retainedEricConfiguration()
describe.skipIf(!configuration)('Authorized retained app-output ERiC validation contract', () => {
  test('Given the exact retained synthetic export, when the pinned official runtime validates it, then the positive and negative content contracts both hold', async () => {
    const settings = configuration!
    const repositoryCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
    // A dirty generator cannot claim the manifest's committed serializer identity.
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', windowsHide: true }).trim()
    if (dirty) throw new Error('Official qualification requires a clean checkout at the pinned repository commit.')
    const result = await runRetainedEricQualification({
      manifest: JSON.parse(await readFile(settings.manifestPath, 'utf8')) as EricRetainedQualificationManifest,
      repositoryCommit, archive: await readFile(settings.packagePath),
      taxonomyArchive: await readFile(path.join(process.cwd(), 'public/taxonomies', OFFICIAL_E_BALANCE_TAXONOMIES[0].archiveFile)),
      configuration: settings.configuration, testTaxNumber: settings.testTaxNumber, evidenceDirectory: settings.evidenceDirectory,
      authorizedValidationOnly: true,
    })
    // All protocol evidence was written already. Never print bridge diagnostics here.
    expect(result.passed, `Retained validation failed; inspect restricted evidence for qualification ${result.qualificationId}.`).toBe(true)
  }, 300_000)
})
