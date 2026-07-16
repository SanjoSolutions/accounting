import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
import { createElsterEBalanceEnvelope } from '@/core/elsterEnvelope'
import { EricProcessingError, runEric } from './eric'

const enabled = process.env.ERIC_INTEGRATION === '1'

describe.skipIf(!enabled)('ERiC 44 native integration', () => {
  it('loads the Bilanz 6.9 plugin and processes an ELSTER v11 envelope', async () => {
    const samplePath = process.env.ERIC_INTEGRATION_XBRL
    if (!samplePath) throw new Error('ERIC_INTEGRATION_XBRL fehlt.')
    const source = await readFile(samplePath, 'utf8')
    const xbrlMatch = source.match(/<xbrli:xbrl[\s\S]*<\/xbrli:xbrl>/)
    if (!xbrlMatch) throw new Error('Die amtliche Beispiel-XBRL-Instanz fehlt.')
    const envelope = createElsterEBalanceEnvelope(xbrlMatch[0], {
      manufacturerId: '74931', dataSupplier: 'Integrationstest', clientVersion: 'Accounting test',
      ticket: 'integrationtest000001', taxNumber: '5192050001276', balanceSheetDate: '2025-12-31', testMarker: '700000004',
    })
    await expect(runEric(envelope, {
      send: false,
      configuration: {
        bridgePath: process.env.ERIC_BRIDGE_PATH!, runtimeDirectory: process.env.ERIC_RUNTIME_DIR!, manufacturerId: '74931', testMarker: '700000004',
      },
    })).rejects.toSatisfy(error => error instanceof EricProcessingError && error.statusCode === 610301202)
  }, 120_000)
})
