import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// A qualification command must fail, rather than report a green skipped suite.
if (process.env.ERIC_RETAINED_CONTRACT_ENABLED?.trim() !== 'true') {
  console.error('Set ERIC_RETAINED_CONTRACT_ENABLED=true only after configuring authorized retained-package validation.')
  process.exitCode = 1
} else {
  const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [vitest, 'run', 'src/server/ericRetained.integration.spec.ts', '--maxWorkers=1'], { stdio: 'inherit', windowsHide: true })
  process.exitCode = result.status ?? 1
}
