import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const host = '127.0.0.1'; const port = Number(process.env.REMINDER_EMAIL_EMULATOR_PORT ?? 3200)
const credential = 'playwright-reminder-email-gateway-credential'
const captures = []; const byKey = new Map()

function json(response, status, body) { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)) }
function readBody(request) { return new Promise((resolve, reject) => { const chunks = []; let size = 0; request.on('data', chunk => { size += chunk.length; if (size > 1_000_000) { reject(new Error('body too large')); request.destroy(); return } chunks.push(chunk) }); request.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (error) { reject(error) } }); request.on('error', reject) }) }

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`)
  if (request.method === 'GET' && url.pathname === '/health') { json(response, 200, { ok: true }); return }
  if (request.method === 'DELETE' && url.pathname === '/captures') { captures.length = 0; byKey.clear(); json(response, 200, { ok: true }); return }
  if (request.method === 'GET' && url.pathname === '/captures') { const recipient = url.searchParams.get('recipient'); json(response, 200, { captures: recipient ? captures.filter(item => item.body.message.to.includes(recipient)) : captures }); return }
  if (request.method !== 'POST' || url.pathname !== '/messages') { json(response, 404, { error: 'not found' }); return }
  if (request.headers.authorization !== `Bearer ${credential}`) { json(response, 401, { error: 'unauthorized' }); return }
  const key = String(request.headers['idempotency-key'] ?? '')
  if (!key) { json(response, 400, { error: 'idempotency key required' }); return }
  const prior = byKey.get(key); if (prior) { json(response, 202, { messageId: prior }); return }
  try {
    const body = await readBody(request)
    if (body?.version !== 1 || !Array.isArray(body?.message?.to) || body.message.to.length !== 1 || !Array.isArray(body?.attachments) || body.attachments.length !== 1) { json(response, 422, { error: 'invalid contract' }); return }
    const attachment = body.attachments[0]; const bytes = Buffer.from(String(attachment.contentBase64 ?? ''), 'base64')
    if (createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) { json(response, 422, { error: 'attachment hash mismatch' }); return }
    const messageId = `local-email-${String(captures.length + 1).padStart(4, '0')}`
    captures.push({ idempotencyKey: key, messageId, body, capturedAt: new Date().toISOString() }); byKey.set(key, messageId)
    json(response, 202, { messageId })
  } catch { json(response, 400, { error: 'invalid JSON' }) }
})

server.listen(port, host, () => process.stdout.write(`Local reminder email gateway listening on http://${host}:${port}\n`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
