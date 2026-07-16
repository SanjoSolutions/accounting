import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

vi.mock('server-only', () => ({}))
import { createEricTicket, getEricConfiguration, getEricReadiness, hashEricRequest } from './eric'

describe('ERiC configuration', () => {
  it('does not accept missing runtime, bridge, or manufacturer ID', async () => {
    const readiness = await getEricReadiness({ bridgePath: '', runtimeDirectory: '', manufacturerId: '' })
    expect(readiness.validationReady).toBe(false)
    expect(readiness.issues).toContain('Eine eigene numerische ERIC_HERSTELLER_ID ist erforderlich.')
  })

  it('keeps the certificate PIN outside environment configuration', () => {
    const configuration = getEricConfiguration({
      ERIC_BRIDGE_PATH: 'bridge.exe', ERIC_RUNTIME_DIR: 'runtime', ERIC_HERSTELLER_ID: '123',
      ERIC_CERTIFICATE_PATH: 'certificate.pfx', ERIC_PIN: 'must-not-be-read',
    })
    expect(configuration).not.toHaveProperty('pin')
  })

  it('creates stable request hashes and unique safe ticket identifiers', () => {
    expect(hashEricRequest('<xml/>')).toBe(hashEricRequest('<xml/>'))
    const first = createEricTicket(); const second = createEricTicket()
    expect(first).toMatch(/^[a-f0-9]{20}$/)
    expect(second).not.toBe(first)
  })

  it('allows validation but blocks binding submissions while a test marker is active', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'eric-readiness-'))
    try {
      const runtimeDirectory = path.join(root, 'runtime'); const pluginDirectory = path.join(runtimeDirectory, 'plugins')
      await mkdir(pluginDirectory, { recursive: true })
      const bridgePath = path.join(root, 'bridge.exe'); const certificatePath = path.join(root, 'certificate.pfx')
      await Promise.all([
        writeFile(bridgePath, ''), writeFile(certificatePath, ''), writeFile(path.join(runtimeDirectory, 'ericapi.dll'), ''),
        writeFile(path.join(pluginDirectory, 'checkBilanz_6_9.dll'), ''),
      ])
      const readiness = await getEricReadiness({ bridgePath, runtimeDirectory, manufacturerId: '12345', certificatePath, testMarker: '700000004' })
      expect(readiness.validationReady).toBe(true)
      expect(readiness.submissionReady).toBe(false)
      expect(readiness.issues).toContain('ERIC_TESTMERKER ist aktiv; rechtswirksame Übermittlungen sind im Testmodus gesperrt.')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
