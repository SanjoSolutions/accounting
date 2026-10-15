import { randomUUID } from 'node:crypto'
import { test } from '@playwright/test'
import { loadQualifiedTaxArtifacts } from '../src/server/tax/qualificationArtifacts'
import { qualifiedContractFormVersions, qualifiedGatewayContractConfiguration, retainQualificationEvidence } from '../src/server/tax/qualificationContract'
import { executeQualifiedTaxContract } from '../src/server/tax/qualificationRunner'

const configuration = qualifiedGatewayContractConfiguration()
// Load and verify the entire matrix before creating any credential-bearing client.
const artifacts = loadQualifiedTaxArtifacts(configuration)
const evidenceRunId = randomUUID()

test.describe('qualified ELSTER gateway interoperability contract', () => {
  test.skip(!configuration.enabled, 'No authorized qualified gateway was explicitly configured. This skip is not interoperability or ELSTER qualification evidence.')

  for (const formVersion of qualifiedContractFormVersions) test(`${formVersion} validates, rejects malformed facts, and returns staging acceptance evidence`, async ({ playwright }) => {
    const artifact = artifacts.find(item => item.dataset.formVersion === formVersion)!
    const context = await playwright.request.newContext({ extraHTTPHeaders: { authorization: `Bearer ${configuration.credential!}`, 'content-type': 'application/json' } })
    try {
      await executeQualifiedTaxContract(artifact, {
        gatewayId: configuration.gatewayId!, qualificationId: configuration.qualificationId!, environment: configuration.environment!,
        credential: configuration.credential!, taxpayerId: configuration.taxpayerId!,
      }, {
        post: async (action, body) => {
          // Never follow a redirect carrying a credential or submission body.
          const response = await context.post(`${configuration.endpoint!}/${action}`, { data: body, maxRedirects: 0, timeout: 60_000 })
          return { status: response.status(), body: await response.text(), contentType: response.headers()['content-type'] }
        },
        retain: async (caseName, evidence) => {
          await retainQualificationEvidence(configuration.protocolDirectory!, `${evidenceRunId}-${formVersion.toLowerCase()}-${caseName}.json`, evidence)
        },
      })
    } finally { await context.dispose() }
  })
})
