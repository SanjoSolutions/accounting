import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export type EricContractOutcome = 'SUCCESS' | 'TEST_MARKER_RESPONSE'

export interface EricQualificationContractConfig {
  enabled: boolean
  authorizedTestMode: boolean
  bridgePath?: string
  runtimeDirectory?: string
  manufacturerId?: string
  testMarker?: string
  testTaxNumber?: string
  sampleXbrlPath?: string
  expectedOutcome?: EricContractOutcome
  expectedStatusCode?: number
  expectedStatusText?: string
  evidenceDirectory?: string
}

const env = (environment: NodeJS.ProcessEnv, name: string) => environment[name]?.trim() ?? ''

export function ericQualificationContractConfiguration(environment: NodeJS.ProcessEnv = process.env): EricQualificationContractConfig {
  const enabled = env(environment, 'ERIC_QUALIFICATION_CONTRACT_ENABLED')
  if (enabled && !['true', 'false'].includes(enabled)) throw new Error('ERIC_QUALIFICATION_CONTRACT_ENABLED must be true or false.')
  if (enabled !== 'true') return { enabled: false, authorizedTestMode: false }
  const authorizedTestMode = env(environment, 'ERIC_QUALIFICATION_AUTHORIZED_TEST_MODE') === 'true'
  const bridgePath = env(environment, 'ERIC_QUALIFICATION_BRIDGE_PATH')
  const runtimeDirectory = env(environment, 'ERIC_QUALIFICATION_RUNTIME_DIR')
  const manufacturerId = env(environment, 'ERIC_QUALIFICATION_MANUFACTURER_ID')
  const testMarker = env(environment, 'ERIC_QUALIFICATION_TEST_MARKER')
  const testTaxNumber = env(environment, 'ERIC_QUALIFICATION_TEST_TAX_NUMBER')
  const sampleXbrlPath = env(environment, 'ERIC_QUALIFICATION_SAMPLE_XBRL')
  const expectedOutcome = env(environment, 'ERIC_QUALIFICATION_EXPECTED_OUTCOME') as EricContractOutcome
  const statusCodeText = env(environment, 'ERIC_QUALIFICATION_EXPECTED_STATUS_CODE')
  const expectedStatusCode = Number(statusCodeText)
  const expectedStatusText = env(environment, 'ERIC_QUALIFICATION_EXPECTED_STATUS_TEXT')
  const evidenceDirectory = env(environment, 'ERIC_QUALIFICATION_EVIDENCE_DIR')
  const issues = [
    ...(!authorizedTestMode ? ['Explicit authorized ERiC test mode is required.'] : []),
    ...(!path.isAbsolute(bridgePath) ? ['The ERiC bridge path must be absolute.'] : []),
    ...(!path.isAbsolute(runtimeDirectory) ? ['The ERiC runtime directory must be absolute.'] : []),
    ...(!/^\d+$/.test(manufacturerId) ? ['A numeric authorized manufacturer ID is required.'] : []),
    ...(!/^\d+$/.test(testMarker) ? ['An explicit numeric ERiC test marker is required.'] : []),
    ...(!/^\d{10,13}$/.test(testTaxNumber) ? ['An authorized numeric test tax number is required.'] : []),
    ...(!path.isAbsolute(sampleXbrlPath) ? ['The official sample XBRL path must be absolute.'] : []),
    ...(!['SUCCESS', 'TEST_MARKER_RESPONSE'].includes(expectedOutcome) ? ['The documented expected outcome must be SUCCESS or TEST_MARKER_RESPONSE.'] : []),
    ...(!statusCodeText || !Number.isSafeInteger(expectedStatusCode) || expectedStatusCode < 0 ? ['An exact expected ERiC status code is required.'] : []),
    ...(expectedOutcome === 'SUCCESS' && expectedStatusCode !== 0 ? ['SUCCESS requires expected status code 0.'] : []),
    ...(expectedOutcome === 'TEST_MARKER_RESPONSE' && (!expectedStatusText || expectedStatusText.length < 4) ? ['A documented test-marker status-text fragment is required.'] : []),
    ...(!path.isAbsolute(evidenceDirectory) ? ['The retained evidence directory must be absolute.'] : []),
    ...(env(environment, 'ERIC_QUALIFICATION_CERTIFICATE_PATH') || env(environment, 'ERIC_QUALIFICATION_PIN') ? ['Certificate and PIN inputs are forbidden for the validation-only contract.'] : []),
  ]
  if (issues.length) throw new Error(issues.join(' '))
  return { enabled: true, authorizedTestMode, bridgePath, runtimeDirectory, manufacturerId, testMarker, testTaxNumber, sampleXbrlPath, expectedOutcome, expectedStatusCode, expectedStatusText, evidenceDirectory }
}

const sensitiveXml = /<(Steuernummer|taxpayerId|name|firma|strasse|straße|ort|plz|iban|pin|certificate)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi

export function redactEricContractText(value: string, secrets: readonly string[] = []) {
  let result = value.replace(sensitiveXml, '<$1>[REDACTED]</$1>').replace(/Bearer\s+[^\s<]+/gi, 'Bearer [REDACTED]')
  for (const secret of secrets.filter(Boolean)) result = result.replaceAll(secret, '[REDACTED]')
  return result.slice(0, 4096)
}

export function ericXmlEvidence(xml: string, _secrets: readonly string[] = []) {
  const structuralPreview = [...xml.matchAll(/<\s*(\/?)\s*([A-Za-z_:][\w:.-]*)/g)]
    .slice(0, 128)
    .map(match => `<${match[1]}${match[2]}>`)
    .join('')
  return {
    sha256: createHash('sha256').update(xml, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(xml, 'utf8'),
    redactedPreview: structuralPreview,
  }
}

export async function retainEricQualificationEvidence(directory: string, fileName: string, evidence: unknown) {
  if (!path.isAbsolute(directory)) throw new Error('ERiC evidence directory must be absolute.')
  if (!/^[A-Za-z0-9._-]+\.json$/.test(fileName)) throw new Error('ERiC evidence filename is invalid.')
  await mkdir(directory, { recursive: true })
  const target = path.resolve(directory, fileName)
  if (path.dirname(target) !== path.resolve(directory)) throw new Error('ERiC evidence must remain inside its configured directory.')
  await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  return target
}
