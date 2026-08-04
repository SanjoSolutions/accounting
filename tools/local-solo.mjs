import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const LOOPBACK_HOST = '127.0.0.1'
const command = process.argv[2]
const forwardedArguments = process.argv.slice(3)

if (command === '--print-config') {
  process.stdout.write(JSON.stringify(localSoloConfiguration('dev', [])))
  process.exit(0)
}
if (!['dev', 'start'].includes(command)) {
  throw new Error('Usage: node tools/local-solo.mjs <dev|start> [Next.js options]')
}
if (forwardedArguments.some(isHostnameOverride)) {
  throw new Error('The local-solo launcher fixes the hostname to 127.0.0.1 and does not accept a hostname override.')
}

const configuration = localSoloConfiguration(command, forwardedArguments)
for (const message of configuration.startupMessages) process.stdout.write(`${message}\n`)
const nextBin = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url))
const child = spawn(process.execPath, [nextBin, ...configuration.arguments], {
  env: { ...process.env, ...configuration.environment },
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (!child.killed) child.kill(signal)
  })
}

child.once('error', error => {
  console.error(error)
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exitCode = code ?? 1
})

function localSoloConfiguration(nextCommand, extraArguments) {
  const database = process.env.DATABASE_URL?.trim() || 'file:./accounting.db'
  return {
    environment: { AUTH_MODE: 'none', APP_BIND_HOST: LOOPBACK_HOST },
    arguments: [nextCommand, '--hostname', LOOPBACK_HOST, ...extraArguments],
    startupMessages: [
      '[local-solo] Authentication: OFF (single local user)',
      `[local-solo] Listening only on http://${LOOPBACK_HOST}${portSuffix(extraArguments)}`,
      `[local-solo] Database: ${database}`,
      '[local-solo] Stop with Ctrl+C. Use `pnpm dev` with AUTH_MODE=credentials for authenticated deployments.',
    ],
  }
}

function isHostnameOverride(argument) {
  return argument === '--hostname' || argument === '-H' || argument.startsWith('--hostname=') || argument.startsWith('-H=') || /^-H[^-]/.test(argument)
}

function portSuffix(arguments_) {
  const index = arguments_.findIndex(argument => argument === '--port' || argument === '-p')
  const separate = index >= 0 ? arguments_[index + 1] : undefined
  const inline = arguments_.find(argument => argument.startsWith('--port='))?.slice('--port='.length) ?? arguments_.find(argument => /^-p\d+$/.test(argument))?.slice(2)
  return `:${separate || inline || '3000'}`
}
