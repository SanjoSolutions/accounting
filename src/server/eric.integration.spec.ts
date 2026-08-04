import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { createElsterEBalanceEnvelope } from '@/core/elsterEnvelope'
import { EricProcessingError, getEricReadiness, hashEricRequest, runEric } from './eric'
import {
  ericQualificationContractConfiguration, ericXmlEvidence, retainEricQualificationEvidence,
} from './ericQualificationContract'

const configuration = ericQualificationContractConfiguration()

describe.skipIf(!configuration.enabled)('manual ERiC Bilanz_6.9 validation contract', () => {
  it('validates an authorized sample envelope without certificate, PIN, submission, or Finanzamt-acceptance claims', async () => {
    const readiness = await getEricReadiness({
      bridgePath: configuration.bridgePath!, runtimeDirectory: configuration.runtimeDirectory!, manufacturerId: configuration.manufacturerId!, testMarker: configuration.testMarker!,
    })
    expect(readiness.validationReady, readiness.issues.join(' ')).toBe(true)
    expect(readiness.submissionReady).toBe(false)
    expect(readiness.testMode).toBe(true)

    const source = await readFile(configuration.sampleXbrlPath!, 'utf8')
    const xbrlMatch = source.match(/<xbrli:xbrl[\s\S]*<\/xbrli:xbrl>/)
    if (!xbrlMatch) throw new Error('The configured official sample has no XBRL instance.')
    const envelope = createElsterEBalanceEnvelope(xbrlMatch[0], {
      manufacturerId: configuration.manufacturerId!, dataSupplier: 'Authorized ERiC contract test', clientVersion: 'Accounting ERiC validation contract',
      ticket: `contract${Date.now()}`.slice(0, 20), taxNumber: configuration.testTaxNumber!, balanceSheetDate: '2025-12-31', testMarker: configuration.testMarker!,
    })

    let observed: { statusCode: number; statusText: string; sent: boolean; resultXml: string; serverResponseXml: string }
    try {
      observed = await runEric(envelope, { send: false, configuration: { bridgePath: configuration.bridgePath!, runtimeDirectory: configuration.runtimeDirectory!, manufacturerId: configuration.manufacturerId!, testMarker: configuration.testMarker! } })
    } catch (error) {
      if (!(error instanceof EricProcessingError)) throw error
      observed = { statusCode: error.statusCode, statusText: error.message, sent: false, resultXml: error.resultXml, serverResponseXml: error.serverResponseXml }
    }

    const secretValues = [configuration.manufacturerId!, configuration.testMarker!, configuration.testTaxNumber!]
    const binaryEvidence = async (filePath: string) => {
      const bytes = await readFile(filePath)
      return { file: path.basename(filePath), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    const evidence = {
      schema: 'eric-bilanz-validation-contract-evidence', version: 1, recordedAt: new Date().toISOString(),
      authority: 'VALIDATION_ONLY_NOT_FINANZAMT_ACCEPTANCE', plugin: 'Bilanz_6.9', sent: observed.sent,
      expected: { outcome: configuration.expectedOutcome, statusCode: configuration.expectedStatusCode, statusTextSha256: configuration.expectedStatusText ? createHash('sha256').update(configuration.expectedStatusText).digest('hex') : undefined },
      observed: { statusCode: observed.statusCode, statusTextSha256: createHash('sha256').update(observed.statusText).digest('hex'), statusTextBytes: Buffer.byteLength(observed.statusText) },
      request: { sha256: hashEricRequest(envelope), sampleXbrlSha256: createHash('sha256').update(xbrlMatch[0]).digest('hex') },
      result: ericXmlEvidence(observed.resultXml, secretValues), serverResponse: ericXmlEvidence(observed.serverResponseXml, secretValues),
      runtime: {
        bridge: await binaryEvidence(configuration.bridgePath!),
        api: await binaryEvidence(path.join(configuration.runtimeDirectory!, 'ericapi.dll')),
        plugin: await binaryEvidence(path.join(configuration.runtimeDirectory!, 'plugins', 'checkBilanz_6_9.dll')),
      },
    }
    const runId = (process.env.GITHUB_RUN_ID?.trim() || `${Date.now()}`).replace(/[^A-Za-z0-9._-]/g, '-')
    const attempt = (process.env.GITHUB_RUN_ATTEMPT?.trim() || 'local').replace(/[^A-Za-z0-9._-]/g, '-')
    await retainEricQualificationEvidence(configuration.evidenceDirectory!, `${runId}-${attempt}-eric-bilanz-6_9.json`, evidence)

    expect(observed.sent).toBe(false)
    expect(observed.statusCode).toBe(configuration.expectedStatusCode)
    if (configuration.expectedOutcome === 'SUCCESS') expect(observed.statusCode).toBe(0)
    else {
      expect(observed.statusCode).not.toBe(0)
      expect(`${observed.statusText}\n${observed.resultXml}\n${observed.serverResponseXml}`.toLocaleLowerCase('de-DE')).toContain(configuration.expectedStatusText!.toLocaleLowerCase('de-DE'))
    }
  }, 120_000)
})
