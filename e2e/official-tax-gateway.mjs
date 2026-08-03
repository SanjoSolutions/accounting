import { createServer } from 'node:http'

const host = '127.0.0.1'
const port = 3199
const credential = 'playwright-only-tax-gateway-credential'

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
    return
  }

  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { body = null }

  const action = request.url?.slice(1)
  const authorized = request.headers.authorization === `Bearer ${credential}`
  const hasDataset = body?.dataset && typeof body.dataset === 'object'
  if (!authorized || !hasDataset || !['validate', 'submit'].includes(action ?? '')) {
    response.writeHead(400, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ error: 'Invalid E2E gateway request.' }))
    return
  }

  response.writeHead(200, { 'content-type': 'application/json' })
  if (action === 'validate') {
    response.end(JSON.stringify({ valid: true, errors: [], protocol: 'e2e-loopback-2026' }))
    return
  }
  if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey) {
    response.end(JSON.stringify({ outcome: 'rejected', errors: ['Missing idempotency key.'] }))
    return
  }
  response.end(JSON.stringify({
    outcome: 'accepted',
    receipt: `e2e-${body.dataset.kind.toLowerCase()}-${body.dataset.period}-receipt`,
  }))
})

server.listen(port, host)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
