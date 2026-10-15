import { describe, expect, test, vi } from 'vitest'
import { qualificationFixtureBundle } from '../../test/qualificationFixtures'
import { parseQualifiedTaxArtifacts, qualificationSha256 } from './qualificationArtifacts'
import { qualifiedContractFormVersions } from './qualificationContract'
import { executeQualifiedTaxContract, type QualificationResponse } from './qualificationRunner'

const config = { environment: 'STAGING' as const, taxpayerId: 'synthetic-authorized-taxpayer', credential: 'synthetic-secret-credential', gatewayId: 'gateway-staging', qualificationId: 'qualification-1' }
function fixture(index = 0, alter?: (body: Record<string, any>, call: number) => void) {
  const bytes = Buffer.from(JSON.stringify(qualificationFixtureBundle()))
  const artifact = parseQualifiedTaxArtifacts(bytes, { ...config, artifactBundleSha256: qualificationSha256(bytes) })[index]
  let call = 0
  const post = vi.fn(async (action: string, request: string): Promise<QualificationResponse> => {
    call++
    const body: Record<string, any> = {
      ...(action === 'validate' ? { valid: call !== 2, errors: call === 2 ? ['Required field missing'] : [] } : { outcome: 'accepted', errors: [], receipt: 'private-receipt' }),
      protocol: { gatewayId: config.gatewayId, qualificationId: config.qualificationId, environment: config.environment, formVersion: artifact.dataset.formVersion, protocolId: action === 'submit' ? 'accepted-protocol' : `validation-${call}`, timestamp: '2026-10-15T00:00:00Z', stage: action === 'submit' ? 'ACCEPTED' : call === 2 ? 'REJECTED' : 'VALIDATED', requestSha256: qualificationSha256(request) },
      unsolicited: 'private-company-address',
    }
    alter?.(body, call)
    return { status: 200, body: JSON.stringify(body) }
  })
  const retain = vi.fn(async (_name: string, _evidence: unknown) => {})
  return { artifact, post, retain }
}

describe('offline qualified gateway contract orchestration (not qualification evidence)', () => {
  test.each(qualifiedContractFormVersions)('Given retained %s, when the adapter acknowledges exact requests, then validation, rejection, acceptance and identical replay are retained', async version => {
    const io = fixture(qualifiedContractFormVersions.indexOf(version))
    await executeQualifiedTaxContract(io.artifact, config, io)
    expect(io.post.mock.calls.map(([action]) => action)).toEqual(['validate', 'validate', 'submit', 'submit'])
    expect(io.post.mock.calls[2][1]).toBe(io.post.mock.calls[3][1])
    const submitted = JSON.parse(io.post.mock.calls[2][1])
    expect(submitted.environment).toBe('STAGING')
    expect(submitted.dataset).toEqual(io.artifact.dataset)
    expect(io.retain.mock.calls.map(([name]) => name)).toEqual(['validation', 'rejection', 'acceptance', 'acceptance-replay'])
    for (const [, evidence] of io.retain.mock.calls) expect(evidence).toMatchObject({ artifact: io.artifact.binding, checksPassed: true, requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    const retained = JSON.stringify(io.retain.mock.calls)
    for (const sensitive of [config.taxpayerId, config.credential, 'private-receipt', 'private-company-address', 'synthetic-preparation']) expect(retained).not.toContain(sensitive)
    expect(retained).toContain(qualificationSha256('private-receipt'))
  })

  test.each(['production', 'other-environment', 'wrong-request', 'missing-request', 'wrong-version', 'wrong-gateway', 'wrong-qualification', 'invalid-positive', 'accepted-negative'])(
    'Given %s validation evidence, when checked, then no submission occurs and the failed check is retained', async fault => {
      const io = fixture(0, (body, call) => {
        if (call === 1) {
          if (fault === 'production') body.protocol.environment = 'PRODUCTION'
          if (fault === 'other-environment') body.protocol.environment = 'TEST'
          if (fault === 'wrong-request') body.protocol.requestSha256 = 'b'.repeat(64)
          if (fault === 'missing-request') delete body.protocol.requestSha256
          if (fault === 'wrong-version') body.protocol.formVersion = 'KST-2026.1'
          if (fault === 'wrong-gateway') body.protocol.gatewayId = 'different'
          if (fault === 'wrong-qualification') body.protocol.qualificationId = 'different'
          if (fault === 'invalid-positive') body.valid = false
        }
        if (call === 2 && fault === 'accepted-negative') body.valid = true
      })
      await expect(executeQualifiedTaxContract(io.artifact, config, io)).rejects.toThrow()
      expect(io.post.mock.calls.every(([action]) => action === 'validate')).toBe(true)
      expect(io.retain.mock.lastCall?.[1]).toMatchObject({ checksPassed: false })
    },
  )

  test('Given an optional field first, when creating the negative case, then an actually required field is removed', async () => {
    const io = fixture()
    const artifact = { ...io.artifact, dataset: { ...io.artifact.dataset, fields: { OPTIONAL: 1, ...io.artifact.dataset.fields } } }
    await executeQualifiedTaxContract(artifact, config, io)
    expect(JSON.parse(io.post.mock.calls[1][1]).dataset.fields).toEqual({ OPTIONAL: 1 })
  })

  test.each(['receipt', 'protocol', 'errors', 'outcome', 'environment', 'request'])(
    'Given changed replay %s, when replay is checked, then the case fails with retained evidence', async fault => {
      const io = fixture(0, (body, call) => {
        if (call !== 4) return
        if (fault === 'receipt') body.receipt = 'changed'
        if (fault === 'protocol') body.protocol.protocolId = 'changed'
        if (fault === 'errors') body.errors = ['not accepted']
        if (fault === 'outcome') body.outcome = 'uncertain'
        if (fault === 'environment') body.protocol.environment = 'PRODUCTION'
        if (fault === 'request') body.protocol.requestSha256 = 'b'.repeat(64)
      })
      await expect(executeQualifiedTaxContract(io.artifact, config, io)).rejects.toThrow()
      expect(io.retain.mock.lastCall?.[1]).toMatchObject({ checksPassed: false })
    },
  )

  test('Given a transport failure containing a credential, when handled, then only a generic failure and exact request binding are retained', async () => {
    const io = fixture()
    io.post.mockRejectedValueOnce(new Error(`authorization: ${config.credential}`))
    await expect(executeQualifiedTaxContract(io.artifact, config, io)).rejects.toThrow('The qualification transport failed')
    expect(io.retain.mock.lastCall?.[1]).toMatchObject({ httpStatus: 0, checksPassed: false, result: { transportError: true } })
    expect(JSON.stringify(io.retain.mock.calls)).not.toContain(config.credential)
  })

  test.each([302, 500, 200])('Given HTTP %s with a non-JSON body, when handled, then raw diagnostics are omitted and no submission follows', async status => {
    const io = fixture()
    const raw = '<html>unrecognized-private-taxpayer-and-address</html>'
    io.post.mockResolvedValueOnce({ status, body: raw })
    await expect(executeQualifiedTaxContract(io.artifact, config, io)).rejects.toThrow(/HTTP 200 and a JSON object/)
    expect(io.post).toHaveBeenCalledTimes(1)
    expect(io.retain.mock.lastCall?.[1]).toMatchObject({ httpStatus: status, result: { responseSha256: qualificationSha256(raw) }, checksPassed: false })
    expect(JSON.stringify(io.retain.mock.calls)).not.toContain('unrecognized-private')
  })

  test('Given evidence retention fails, when validation completes, then submission remains blocked', async () => {
    const io = fixture()
    io.retain.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(executeQualifiedTaxContract(io.artifact, config, io)).rejects.toThrow(/storage unavailable/)
    expect(io.post).toHaveBeenCalledTimes(1)
  })
})
