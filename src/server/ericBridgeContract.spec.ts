import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { EricProcessingError, runEric } from './eric'

let directory: string | undefined
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); vi.clearAllMocks() })

describe('Native ERiC bridge contract boundary', () => {
  test.each([
    { sent: false, statusCode: 1234, exitCode: 2, completed: true },
    { sent: true, statusCode: 1234, exitCode: 2, completed: true },
    { sent: undefined, statusCode: 1234, exitCode: 2, completed: false },
    { sent: false, statusCode: 0, exitCode: null, completed: false },
  ])('Given native response $statusCode/$sent and exit $exitCode, when validation finishes, then authentication stays absent and uncertainty is preserved', async ({ sent, statusCode, exitCode, completed }) => {
    directory = await mkdtemp(path.join(tmpdir(), 'eric-bridge-boundary-'))
    await mkdir(path.join(directory, 'plugins'))
    const bridgePath = path.join(directory, 'bridge.exe')
    const certificatePath = path.join(directory, 'never-used.pfx')
    await Promise.all([bridgePath, certificatePath, path.join(directory, 'ericapi.dll'), path.join(directory, 'plugins/checkBilanz_6_9.dll')].map(file => writeFile(file, 'synthetic')))
    let nativeRequest: Record<string, unknown> | undefined
    vi.mocked(spawn).mockImplementation(() => {
      const stdout = new PassThrough()
      const child = Object.assign(new EventEmitter(), { stdout, kill: vi.fn(), stdin: new Writable({
        write(chunk, _encoding, callback) {
          nativeRequest = JSON.parse(chunk.toString())
          Promise.all([
            writeFile(nativeRequest!.resultPath as string, '<diagnostic/>'),
            writeFile(nativeRequest!.serverResponsePath as string, ''),
          ]).then(() => {
            stdout.end(JSON.stringify({ statusCode, statusText: 'synthetic rejection', sent }))
            child.emit('close', exitCode)
            callback()
          }, callback)
        },
      }) })
      return child as unknown as ReturnType<typeof spawn>
    })
    let observed: unknown
    try {
      await runEric('<synthetic/>', { send: false, pin: 'must-not-reach-native-validation',
        configuration: { bridgePath, runtimeDirectory: directory, manufacturerId: '12345', testMarker: '700000004', certificatePath } })
    } catch (error) { observed = error }
    expect(nativeRequest?.send).toBe(false)
    expect(nativeRequest).not.toHaveProperty('pin')
    expect(nativeRequest).not.toHaveProperty('certificatePath')
    if (sent === undefined) {
      expect(observed).not.toBeInstanceOf(EricProcessingError)
      expect(observed).toMatchObject({ message: 'Die ERiC-Bridge lieferte keine vollständige Statusantwort.' })
    } else {
      expect(observed).toBeInstanceOf(EricProcessingError)
      expect(observed).toMatchObject({ sent, statusCode, bridgeCompleted: completed, resultXml: '<diagnostic/>' })
    }
  })
})
