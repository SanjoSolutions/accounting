import { createHash } from 'node:crypto'
import { test, type APIResponse } from '@playwright/test'
import {
  assertQualifiedDisclosureResponse, captureDisclosureRemoteResponse, disclosureQualificationEvidence, qualifiedDisclosureCases,
  qualifiedDisclosureContractConfiguration, retainDisclosureQualificationEvidence, type QualifiedDisclosureStage,
} from '../src/server/compliance/disclosureQualificationContract'
import { disclosureQualificationRequest, disclosureSubmissionKey, loadDisclosureQualificationPackages } from '../src/server/compliance/disclosureQualificationPackages'

const configuration = qualifiedDisclosureContractConfiguration()
const evidenceRunId = `${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`.replace(/[^A-Za-z0-9._-]/g, '-')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

test.describe('qualified Unternehmensregister gateway interoperability contract', () => {
  test.skip(!configuration.enabled, 'No authorized gateway configured. A skip is not qualification evidence.')

  for (const disclosureCase of qualifiedDisclosureCases) test(`Given reviewed ${disclosureCase} bytes, when delivered non-binding, then validation, rejection, acceptance and replay bind to those bytes`, async ({ playwright }) => {
    const config = {
      gatewayId: configuration.gatewayId!, qualificationId: configuration.qualificationId!, schemaVersion: configuration.schemaVersion!,
      environment: configuration.environment!, submitterId: configuration.submitterId!,
    }
    // Verify ALL cases before creating a credential-bearing client or making any request.
    const packages = await loadDisclosureQualificationPackages(configuration.fixtureDirectory!, configuration.fixtureManifestSha256!, config)
    const pkg = packages.find(item => item.disclosureCase === disclosureCase)!
    const dataset = disclosureQualificationRequest(pkg, config)
    const secrets = [configuration.credential!, config.submitterId]
    const context = await playwright.request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${configuration.credential!}`, 'content-type': 'application/json' }, maxRedirects: 0 })
    const check = async (caseName: string, route: string, request: { dataset: typeof dataset; idempotencyKey?: string }, stage: QualifiedDisclosureStage, previous?: { receiptSha256?: string; protocol: Record<string, unknown> }) => {
      let response: APIResponse
      try { response = await context.post(`${configuration.endpoint}/${route}`, { data: request }) }
      catch { throw new Error('Disclosure transport failed; no provider outcome established. Inspect the protected gateway logs.') }
      const captured = captureDisclosureRemoteResponse(await response.text(), response.headers()['content-type'])
      const body = captured.parsed && typeof captured.parsed === 'object' && !Array.isArray(captured.parsed) ? captured.parsed as Record<string, unknown> : {}
      const receiptSha256 = typeof body.receipt === 'string' && body.receipt.trim() ? hash(body.receipt) : undefined
      let contractPassed = false
      let protocol: Record<string, unknown> | undefined
      try {
        const checked = assertQualifiedDisclosureResponse(response.status(), body, {
          ...config, disclosureCase, fiscalYear: pkg.fiscalYear, stage,
          sourcePackageChecksum: pkg.sourcePackageChecksum, packageSha256: request.dataset.packageSha256,
          requestSha256: hash(JSON.stringify(request)),
        }, previous)
        protocol = checked.protocol
        contractPassed = true
        return checked
      } finally {
        await retainDisclosureQualificationEvidence(configuration.protocolDirectory!, `${evidenceRunId}-${disclosureCase.toLowerCase()}-${caseName}.json`, disclosureQualificationEvidence({
          config, disclosureCase, fiscalYear: pkg.fiscalYear, caseName, request, httpStatus: response.status(), contractPassed,
          result: { response: captured.evidence, receiptSha256 }, protocol: contractPassed ? protocol : undefined, secrets,
          binding: { manifestSha256: pkg.manifestSha256, annualBundleSha256: pkg.annualBundleSha256, manualBundleSha256: pkg.manualBundleSha256, sourcePackageChecksum: pkg.sourcePackageChecksum, packageSha256: request.dataset.packageSha256, adapterVersion: pkg.adapterVersion },
        }))
      }
    }

    try {
      await check('validation', 'validate', { dataset }, 'VALIDATED')
      await check('rejection', 'validate', { dataset: disclosureQualificationRequest(pkg, config, true) }, 'REJECTED')
      const request = { dataset, idempotencyKey: disclosureSubmissionKey(dataset) }
      const accepted = await check('acceptance', 'submit', request, 'ACCEPTED')
      await check('acceptance-replay', 'submit', request, 'ACCEPTED', accepted)
    } finally { await context.dispose() }
  })
})
