import 'server-only'

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AccountingValidationError } from '@/core/doubleEntry'

const MAX_XML_BYTES = 60 * 1024 * 1024

export interface EricConfiguration {
  bridgePath: string
  runtimeDirectory: string
  manufacturerId: string
  certificatePath?: string
  testMarker?: string
}

export interface EricReadiness {
  validationReady: boolean
  submissionReady: boolean
  testMode: boolean
  issues: string[]
}

export interface EricResult {
  statusCode: number
  statusText: string
  sent: boolean
  resultXml: string
  serverResponseXml: string
}

export function getEricConfiguration(environment: NodeJS.ProcessEnv = process.env): EricConfiguration {
  return {
    bridgePath: environment.ERIC_BRIDGE_PATH?.trim() ?? '',
    runtimeDirectory: environment.ERIC_RUNTIME_DIR?.trim() ?? '',
    manufacturerId: environment.ERIC_HERSTELLER_ID?.trim() ?? '',
    certificatePath: environment.ERIC_CERTIFICATE_PATH?.trim() || undefined,
    testMarker: environment.ERIC_TESTMERKER?.trim() || undefined,
  }
}

export async function getEricReadiness(configuration = getEricConfiguration()): Promise<EricReadiness> {
  const issues: string[] = []
  if (!configuration.bridgePath) issues.push('ERIC_BRIDGE_PATH ist nicht konfiguriert.')
  else if (!await exists(configuration.bridgePath)) issues.push('Die konfigurierte ERiC-Bridge wurde nicht gefunden.')
  if (!configuration.runtimeDirectory) issues.push('ERIC_RUNTIME_DIR ist nicht konfiguriert.')
  else {
    if (!await exists(path.join(configuration.runtimeDirectory, 'ericapi.dll'))) issues.push('ericapi.dll fehlt im konfigurierten ERiC-Verzeichnis.')
    if (!await exists(path.join(configuration.runtimeDirectory, 'plugins', 'checkBilanz_6_9.dll'))) issues.push('Das ERiC-Prüfplugin checkBilanz_6_9.dll fehlt.')
  }
  if (!/^\d+$/.test(configuration.manufacturerId)) issues.push('Eine eigene numerische ERIC_HERSTELLER_ID ist erforderlich.')
  const validationReady = issues.length === 0
  const certificateReady = Boolean(configuration.certificatePath && await exists(configuration.certificatePath))
  const testMode = Boolean(configuration.testMarker)
  const submissionReady = validationReady && certificateReady && !testMode
  const readinessIssues = [...issues]
  if (validationReady && !certificateReady) readinessIssues.push('Für die Übermittlung ist ERIC_CERTIFICATE_PATH erforderlich.')
  if (validationReady && testMode) readinessIssues.push('ERIC_TESTMERKER ist aktiv; rechtswirksame Übermittlungen sind im Testmodus gesperrt.')
  return {
    validationReady,
    submissionReady,
    testMode,
    issues: readinessIssues,
  }
}

export async function runEric(
  xml: string,
  options: { send: boolean; pin?: string; configuration?: EricConfiguration; timeoutMs?: number },
): Promise<EricResult> {
  const configuration = options.configuration ?? getEricConfiguration()
  const readiness = await getEricReadiness(configuration)
  const blocking = options.send ? !readiness.submissionReady : !readiness.validationReady
  if (blocking) throw new AccountingValidationError(readiness.issues)
  if (Buffer.byteLength(xml, 'utf8') > MAX_XML_BYTES) throw new AccountingValidationError(['Der ELSTER-Datensatz überschreitet die ERiC-Grenze von 60 MiB.'])
  if (options.send && !options.pin) throw new AccountingValidationError(['Für die Übermittlung ist die Zertifikats-PIN erforderlich.'])

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'accounting-eric-'))
  const xmlPath = path.join(temporaryDirectory, 'request.xml')
  const resultPath = path.join(temporaryDirectory, 'result.xml')
  const serverResponsePath = path.join(temporaryDirectory, 'server-response.xml')
  const logDirectory = path.join(temporaryDirectory, 'logs')
  try {
    await writeFile(xmlPath, xml, { encoding: 'utf8', mode: 0o600 })
    const bridgeRequest = JSON.stringify({
      runtimeDirectory: configuration.runtimeDirectory,
      logDirectory,
      xmlPath,
      resultPath,
      serverResponsePath,
      send: options.send,
      certificatePath: options.send ? configuration.certificatePath : undefined,
      pin: options.send ? options.pin : undefined,
    })
    const processResult = await executeBridge(configuration.bridgePath, bridgeRequest, options.timeoutMs ?? 120_000)
    let parsed: { statusCode?: unknown; statusText?: unknown; sent?: unknown }
    try { parsed = JSON.parse(processResult.stdout) as typeof parsed }
    catch { throw new Error('Die ERiC-Bridge lieferte keine gültige Antwort.') }
    const statusCode = typeof parsed.statusCode === 'number' ? parsed.statusCode : -1
    const statusText = typeof parsed.statusText === 'string' ? parsed.statusText : 'Unbekannte ERiC-Antwort.'
    const resultXml = await readOptional(resultPath)
    const serverResponseXml = await readOptional(serverResponsePath)
    if (processResult.exitCode !== 0 || statusCode !== 0) {
      throw new EricProcessingError(statusCode, statusText, resultXml, serverResponseXml)
    }
    return { statusCode, statusText, sent: parsed.sent === true, resultXml, serverResponseXml }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

export class EricProcessingError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly resultXml: string,
    readonly serverResponseXml: string,
  ) { super(message); this.name = 'EricProcessingError' }
}

export function hashEricRequest(xml: string): string {
  return createHash('sha256').update(xml, 'utf8').digest('hex')
}

export function createEricTicket(): string {
  return randomUUID().replaceAll('-', '').slice(0, 20)
}

async function executeBridge(executable: string, stdin: string, timeoutMs: number) {
  return new Promise<{ exitCode: number | null; stdout: string }>((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let stdout = ''
    const timeout = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      stdout += chunk
      if (stdout.length > 1024 * 1024) child.kill()
    })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', exitCode => { clearTimeout(timeout); resolve({ exitCode, stdout }) })
    child.stdin.end(stdin, 'utf8')
  })
}

async function exists(filePath: string) {
  try { await access(filePath); return true } catch { return false }
}

async function readOptional(filePath: string) {
  try { return await readFile(filePath, 'utf8') } catch { return '' }
}
