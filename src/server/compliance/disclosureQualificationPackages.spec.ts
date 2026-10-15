import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, test } from 'vitest'
import { annualDocumentFixture } from '../../test/annualDocumentFixture'
import { ANNUAL_DOCUMENT_RENDERER, annualDocumentFiles, hashDocument, type AnnualDocumentMode, type AnnualDocumentSource } from '../../core/compliance/annualDocuments'
import { disclosureQualificationRequest, disclosureSubmissionKey, loadDisclosureQualificationPackages, type DisclosureQualificationManifest } from './disclosureQualificationPackages'

const config = { gatewayId: 'gateway-1', qualificationId: 'qualification-1', schemaVersion: 'provider-schema-1', environment: 'STAGING' as const, submitterId: 'synthetic-submitter' }

function bundle(source: AnnualDocumentSource, mode: AnnualDocumentMode) {
  const selection = { noteIndexes: [0, 1], policyIndexes: source.input.profile.size === 'SMALL' ? [0] : [], establishedOn: '2027-03-03', confirmedCompleteAndMinimized: true as const }
  const files = annualDocumentFiles(source, mode, selection)
  files['manifest.json'] = JSON.stringify({
    format: ANNUAL_DOCUMENT_RENDERER, mode, status: 'EXPORTED_NOT_FILED',
    sourcePackageId: source.packageId, sourceVersion: source.packageVersion, sourceChecksum: source.packageChecksum,
    sourceCloseId: source.close.id, sourceCloseChecksum: source.close.checksum, approval: { by: source.approvedBy, at: source.approvedAt },
    ...(mode === 'manual' ? { review: 'USER_CONFIRMED_COMPLETE_AND_MINIMIZED', disclosureSelection: selection } : {}),
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, { sha256: hashDocument(content), bytes: Buffer.byteLength(content) }])),
  })
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)])))
}

async function withFixtures(run: (fixture: { directory: string; manifest: DisclosureQualificationManifest; pin: () => Promise<string> }) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'disclosure-inputs-'))
  const manifest: DisclosureQualificationManifest = { format: 'disclosure-qualification-inputs-1', ...config, adapterVersion: 'synthetic-unit-adapter-1', review: { syntheticDataOnly: true, nonBinding: true, mappingApproved: true }, cases: [] }
  const save = async (file: string, bytes: Uint8Array) => { await writeFile(path.join(directory, file), bytes); return { file, sha256: hashDocument(bytes) } }
  try {
    for (const size of ['MICRO', 'SMALL'] as const) {
      const source = annualDocumentFixture(size)
      manifest.cases.push({
        disclosureCase: size === 'MICRO' ? 'MICRO-HINTERLEGUNG' : 'SMALL-OFFENLEGUNG',
        annualBundle: await save(`${size}-annual.zip`, bundle(source, 'annual')),
        manualBundle: await save(`${size}-manual.zip`, bundle(source, 'manual')),
        // Deliberate unit fixtures, never provider qualification evidence.
        validPayload: await save(`${size}-valid.xml`, strToU8(`<unit-fixture case="${size}" />`)),
        invalidPayload: await save(`${size}-invalid.xml`, strToU8('<unit-fixture deliberately-invalid="true" />')),
      })
    }
    await run({ directory, manifest, pin: async () => { const content = JSON.stringify(manifest); await writeFile(path.join(directory, 'manifest.json'), content); return hashDocument(content) } })
  } finally { await rm(directory, { recursive: true, force: true }) }
}

describe('retained disclosure qualification packages', () => {
  test('Given both app exports and pinned payloads, when prepared, then exact bytes and source checksums bind to private-data-free requests and content-specific keys', async () => {
    await withFixtures(async ({ directory, manifest, pin }) => {
      const packages = await loadDisclosureQualificationPackages(directory, await pin(), config)
      expect(packages).toHaveLength(2)
      for (const pkg of packages) {
        const request = disclosureQualificationRequest(pkg, config)
        expect(request).toMatchObject({ environment: 'STAGING', nonBinding: true, sourcePackageChecksum: 'a'.repeat(64), fiscalYear: 2026 })
        expect(hashDocument(Buffer.from(request.payload.content, 'base64'))).toBe(request.packageSha256)
        expect(JSON.stringify(request)).not.toMatch(/PRIVATE|Geheimkunde|private-signature|abschluss.json|incomeStatement/)
        expect(request.packageSha256).toBe(manifest.cases.find(entry => entry.disclosureCase === pkg.disclosureCase)!.validPayload.sha256)
        const rejected = disclosureQualificationRequest(pkg, config, true)
        expect(rejected.packageSha256).not.toBe(request.packageSha256)
        expect(disclosureSubmissionKey(request)).toBe(disclosureSubmissionKey({ ...request }))
        for (const changed of [rejected, { ...request, submitterId: 'another' }, { ...request, environment: 'TEST' as const }, { ...request, schemaVersion: 'another' }, { ...request, sourcePackageChecksum: 'f'.repeat(64) }]) expect(disclosureSubmissionKey(changed)).not.toBe(disclosureSubmissionKey(request))
      }
    })
  })

  test('Given altered manifest or payload bytes, when loaded, then no transmission input is returned', async () => {
    await withFixtures(async ({ directory, manifest, pin }) => {
      await expect(loadDisclosureQualificationPackages(directory, '0'.repeat(64), config)).rejects.toThrow()
      const checksum = await pin()
      await writeFile(path.join(directory, manifest.cases[1].validPayload.file), '<substituted />')
      await expect(loadDisclosureQualificationPackages(directory, checksum, config)).rejects.toThrow(/missing, changed/)
    })
  })

  test.each(['missing-case', 'duplicate-case', 'wrong-schema', 'wrong-environment', 'missing-adapter', 'unreviewed', 'real-data', 'binding', 'identical-invalid', 'traversal'])(
    'Given %s fixtures, when loaded, then qualification fails before networking', async scenario => {
      await withFixtures(async ({ directory, manifest, pin }) => {
        if (scenario === 'missing-case') manifest.cases.pop()
        if (scenario === 'duplicate-case') manifest.cases[1] = manifest.cases[0]
        if (scenario === 'wrong-schema') manifest.schemaVersion = 'other'
        if (scenario === 'wrong-environment') manifest.environment = 'TEST'
        if (scenario === 'missing-adapter') delete (manifest as Partial<DisclosureQualificationManifest>).adapterVersion
        if (scenario === 'unreviewed') manifest.review.mappingApproved = false as never
        if (scenario === 'real-data') manifest.review.syntheticDataOnly = false as never
        if (scenario === 'binding') manifest.review.nonBinding = false as never
        if (scenario === 'identical-invalid') manifest.cases[1].invalidPayload = manifest.cases[1].validPayload
        if (scenario === 'traversal') manifest.cases[0].validPayload.file = '../outside.xml'
        await expect(loadDisclosureQualificationPackages(directory, await pin(), config)).rejects.toThrow()
      })
    },
  )

  test.each(['source-checksum', 'source-version', 'close', 'approval', 'member', 'extra-private-member', 'selection', 'companion'])('Given a repinned archive with changed %s, when loaded, then app export binding still fails', async scenario => {
    await withFixtures(async ({ directory, manifest, pin }) => {
      const entry = scenario === 'companion' ? manifest.cases[0].annualBundle : manifest.cases[0].manualBundle
      const files = unzipSync(await readFile(path.join(directory, entry.file)))
      const metadata = JSON.parse(strFromU8(files['manifest.json']))
      if (scenario === 'source-checksum') metadata.sourceChecksum = 'f'.repeat(64)
      if (scenario === 'source-version') metadata.sourceVersion++
      if (scenario === 'close') metadata.sourceCloseId = 'other'
      if (scenario === 'approval') metadata.approval.by = 'other'
      if (scenario === 'member') files['einreichung.html'] = strToU8('substituted')
      if (scenario === 'extra-private-member') files['private.json'] = strToU8('{}')
      if (scenario === 'selection') metadata.disclosureSelection.noteIndexes = [0]
      if (scenario === 'companion') {
        const source = JSON.parse(strFromU8(files['abschluss.json']))
        source.input.profile.legalName = 'substituted'
        files['abschluss.json'] = strToU8(JSON.stringify(source))
        metadata.files['abschluss.json'] = { sha256: hashDocument(files['abschluss.json']), bytes: files['abschluss.json'].byteLength }
      }
      files['manifest.json'] = strToU8(JSON.stringify(metadata))
      const changed = zipSync(files)
      await writeFile(path.join(directory, entry.file), changed); entry.sha256 = hashDocument(changed)
      await expect(loadDisclosureQualificationPackages(directory, await pin(), config)).rejects.toThrow()
    })
  })
})
