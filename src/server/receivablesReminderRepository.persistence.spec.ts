import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/server/authentication', () => ({ getCurrentUser: vi.fn(async () => ({ id: 'tenant-a', actorId: 'actor-a', role: 'ADMIN' })) }))
const directory = mkdtempSync(join(tmpdir(), 'accounting-reminders-'))
const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
let api: typeof import('./receivablesReminderRepository')
let prisma: typeof import('@/server/persistence/client').prisma
let postReminder: typeof import('@/app/api/commercial/reminders/route').POST
let getPrint: typeof import('@/app/api/commercial/reminders/[id]/print/route').GET
let postDelivery: typeof import('@/app/api/commercial/reminders/[id]/deliveries/route').POST
let emailServer: Server
const capturedEmails: Array<{ idempotencyKey: string; body: Record<string, unknown> }> = []
const providerMessages = new Map<string, string>()

beforeAll(async () => {
  emailServer = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(Buffer.from(chunk))); request.on('end', () => {
      const authorization = request.headers.authorization; const idempotencyKey = String(request.headers['idempotency-key'] ?? '')
      if (authorization !== 'Bearer persistence-email-secret') { response.writeHead(401).end('{}'); return }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      const recipient = ((body.message as { to?: string[] })?.to ?? [])[0]
      if (recipient === 'fail@example.de') { response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'provider unavailable' })); return }
      let messageId = providerMessages.get(idempotencyKey)
      if (!messageId) { messageId = `captured-${providerMessages.size + 1}`; providerMessages.set(idempotencyKey, messageId); capturedEmails.push({ idempotencyKey, body }) }
      response.writeHead(202, { 'content-type': 'application/json' }).end(JSON.stringify({ messageId }))
    })
  })
  await new Promise<void>(resolve => emailServer.listen(0, '127.0.0.1', resolve))
  const address = emailServer.address(); if (!address || typeof address === 'string') throw new Error('Email test gateway did not bind.')
  process.env.REMINDER_EMAIL_GATEWAY_URL = `http://127.0.0.1:${address.port}`; process.env.REMINDER_EMAIL_GATEWAY_CREDENTIAL = 'persistence-email-secret'
  const database = new DatabaseSync(databasePath)
  for (const name of readdirSync(resolve(process.cwd(), 'prisma/migrations'), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) database.exec(readFileSync(resolve(process.cwd(), 'prisma/migrations', name, 'migration.sql'), 'utf8'))
  database.close(); process.env.DATABASE_URL = `file:${databasePath}`
  api = await import('./receivablesReminderRepository'); prisma = (await import('@/server/persistence/client')).prisma
  postReminder = (await import('@/app/api/commercial/reminders/route')).POST; getPrint = (await import('@/app/api/commercial/reminders/[id]/print/route')).GET; postDelivery = (await import('@/app/api/commercial/reminders/[id]/deliveries/route')).POST
  await prisma.documentRecord.createMany({ data: [{ id: 'evidence-a', ownerId: 'tenant-a', payload: '{}' }, { id: 'evidence-b', ownerId: 'tenant-b', payload: '{}' }] })
  await prisma.businessPartner.createMany({ data: [
    { id: 'customer-a', ownerId: 'tenant-a', partnerNumber: 'K-1', role: 'CUSTOMER', name: 'Customer <GmbH>' },
    { id: 'supplier-a', ownerId: 'tenant-a', partnerNumber: 'L-1', role: 'SUPPLIER', name: 'Supplier GmbH' },
    { id: 'customer-b', ownerId: 'tenant-b', partnerNumber: 'K-1', role: 'CUSTOMER', name: 'Other tenant' },
  ] })
  const documents = [
    ['doc-overdue', 'tenant-a', 'customer-a', 'RECEIVABLE', 'INVOICE', 'OPEN-1', '2026-07-01', 'FINAL'],
    ['doc-not-due', 'tenant-a', 'customer-a', 'RECEIVABLE', 'INVOICE', 'FUTURE-1', '2026-08-10', 'FINAL'],
    ['doc-payable', 'tenant-a', 'supplier-a', 'PAYABLE', 'INVOICE', 'PAY-1', '2026-07-01', 'FINAL'],
    ['doc-other', 'tenant-b', 'customer-b', 'RECEIVABLE', 'INVOICE', 'OTHER-1', '2026-07-01', 'FINAL'],
    ['doc-draft', 'tenant-a', 'customer-a', 'RECEIVABLE', 'INVOICE', 'DRAFT-1', '2026-07-01', 'DRAFT'],
  ] as const
  for (const [id, ownerId, businessPartnerId, direction, kind, documentNumber, due, status] of documents) await prisma.commercialDocument.create({ data: { id, ownerId, businessPartnerId, direction, kind, status, documentNumber, documentIdentityKey: status === 'DRAFT' ? null : `${ownerId}-${id}`, issueDate: new Date('2026-06-01'), evidenceDocumentId: status === 'DRAFT' ? null : ownerId === 'tenant-a' ? 'evidence-a' : 'evidence-b', counterpartySnapshot: status === 'DRAFT' ? null : '{}', serviceDate: new Date('2026-06-01'), dueDate: new Date(due), description: 'Test', currency: 'EUR', netAmountCents: 10_000, taxAmountCents: 1_900, grossAmountCents: 11_900, payableAmountCents: 11_900, openItem: { create: { id: `oi-${id}`, side: direction === 'RECEIVABLE' ? 'DEBIT' : 'CREDIT', currency: 'EUR', originalAmountCents: 11_900 } } } })
})

afterAll(async () => { await prisma.$disconnect(); await new Promise<void>((resolve, reject) => emailServer.close(error => error ? reject(error) : resolve())); delete process.env.DATABASE_URL; delete process.env.REMINDER_EMAIL_GATEWAY_URL; delete process.env.REMINDER_EMAIL_GATEWAY_CREDENTIAL; rmSync(directory, { recursive: true, force: true }) })

describe('persistent receivables reminder repository on migrated SQLite', () => {
  it('Given an overdue customer open item, when a reminder is issued and retried, then one immutable level-one snapshot exists without changing the open item', async () => {
    const before = await prisma.openItem.findUniqueOrThrow({ where: { id: 'oi-doc-overdue' } })
    const input = { openItemId: before.id, issuedOn: '2026-08-04', paymentDueDate: '2026-08-11', reason: 'Manual reminder approved' }
    const first = await api.issueReceivablesReminder('tenant-a', 'actor-a', 'reminder-request-0001', input)
    const replay = await api.issueReceivablesReminder('tenant-a', 'actor-a', 'reminder-request-0001', input)
    expect(replay.id).toBe(first.id); expect(first).toMatchObject({ level: 1, remainingAmountCents: 11_900, invoiceNumber: 'OPEN-1' })
    expect(first.printableHtml).not.toContain('<GmbH>')
    expect(await prisma.openItem.findUniqueOrThrow({ where: { id: before.id } })).toMatchObject({ originalAmountCents: before.originalAmountCents, allocatedAmountCents: before.allocatedAmountCents, status: before.status })
    await expect(prisma.$executeRawUnsafe(`UPDATE ReceivablesReminder SET level = 9 WHERE id = '${first.id}'`)).rejects.toThrow(/immutable/)
  })

  it('Given reminder history, when another reminder is issued, then the level is sequential and the earlier snapshot remains unchanged', async () => {
    const second = await api.issueReceivablesReminder('tenant-a', 'actor-a', 'reminder-request-0002', { openItemId: 'oi-doc-overdue', issuedOn: '2026-08-05', paymentDueDate: '2026-08-12', reason: 'Second manual reminder' })
    expect(second.level).toBe(2); await expect(api.listReceivablesReminders('tenant-b')).resolves.toEqual([])
  })

  it('Given two concurrent deliveries with the same durable issue key, when both race, then both resolve to one persisted idempotent winner', async () => {
    const input = { openItemId: 'oi-doc-overdue', issuedOn: '2026-08-06', paymentDueDate: '2026-08-13', reason: 'Concurrent transport retry' }
    const [left, right] = await Promise.all([
      api.issueReceivablesReminder('tenant-a', 'actor-a', 'reminder-concurrent-issue', input),
      api.issueReceivablesReminder('tenant-a', 'actor-a', 'reminder-concurrent-issue', input),
    ])
    expect(left.id).toBe(right.id); expect(left.level).toBe(3)
    await expect(prisma.receivablesReminder.count({ where: { ownerId: 'tenant-a', requestKey: 'reminder-concurrent-issue' } })).resolves.toBe(1)
  })

  it.each([['not due', 'oi-doc-not-due'], ['payable', 'oi-doc-payable'], ['foreign tenant', 'oi-doc-other'], ['draft invoice', 'oi-doc-draft']])('Given a %s open item, when a tenant issues a reminder, then persistence fails closed', async (_label, openItemId) => {
    await expect(api.issueReceivablesReminder('tenant-a', 'actor-a', `blocked-request-${openItemId}`, { openItemId, issuedOn: '2026-08-04', paymentDueDate: '2026-08-11', reason: 'Must fail' })).rejects.toThrow()
  })

  it('Given a draft invoice open item, when persistence is called directly without domain validation, then the migrated SQLite trigger rejects the reminder', async () => {
    const direct = new DatabaseSync(databasePath)
    try {
      expect(() => direct.prepare('INSERT INTO ReceivablesReminder (id,ownerId,openItemId,level,requestKey,requestHash,issuedOn,paymentDueDate,originalDueDate,remainingAmountCents,currency,invoiceNumber,partnerSnapshot,issuerSnapshot,printableHtml,createdBy) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('forged-draft-reminder', 'tenant-a', 'oi-doc-draft', 1, 'forged-draft-request', '0'.repeat(64), '2026-08-04T00:00:00.000Z', '2026-08-11T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 11_900, 'EUR', 'DRAFT-1', '{}', '{}', '<html></html>', 'forger')).toThrow(/Reminder is not eligible/)
    } finally { direct.close() }
  })

  it('Given an issued reminder and an explicitly reviewed customer address, when authenticated API delivery is replayed, then one provider message and immutable SENT result persist without changing open-item accounting', async () => {
    const reminder = (await api.listReceivablesReminders('tenant-a'))[0]
    const before = await prisma.openItem.findUniqueOrThrow({ where: { id: reminder.openItemId } })
    const body = { requestKey: 'delivery-api-request-0001', recipient: ' Billing@Example.DE ', reason: 'Operator reviewed address against customer instruction' }
    const request = () => new Request(`http://localhost/api/commercial/reminders/${reminder.id}/deliveries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const first = await postDelivery(request(), { params: Promise.resolve({ id: reminder.id }) }); const replay = await postDelivery(request(), { params: Promise.resolve({ id: reminder.id }) })
    expect(first.status).toBe(201); expect(replay.status).toBe(201)
    const payload = await first.json(); expect(payload.data).toMatchObject({ recipient: 'billing@example.de', requestedBy: 'actor-a', result: { status: 'SENT', providerMessageId: 'captured-1' } })
    expect(capturedEmails).toHaveLength(1); expect(capturedEmails[0]!.body).toMatchObject({ version: 1, message: { to: ['billing@example.de'], subject: 'Zahlungserinnerung zu Rechnung OPEN-1' } })
    await expect(api.deliverReceivablesReminder('tenant-a', 'actor-a', reminder.id, body.requestKey, { recipient: body.recipient, reason: 'A different claimed approval' })).rejects.toThrow(/different facts/)
    const attachment = (capturedEmails[0]!.body.attachments as Array<{ contentBase64: string; sha256: string }>)[0]!
    expect(Buffer.from(attachment.contentBase64, 'base64').toString('utf8')).toContain('Zahlungserinnerung Stufe')
    expect(createHash('sha256').update(Buffer.from(attachment.contentBase64, 'base64')).digest('hex')).toBe(attachment.sha256)
    expect(await prisma.openItem.findUniqueOrThrow({ where: { id: reminder.openItemId } })).toMatchObject({ originalAmountCents: before.originalAmountCents, allocatedAmountCents: before.allocatedAmountCents, status: before.status })
    await expect(prisma.$executeRawUnsafe(`UPDATE ReceivablesReminderDeliveryResult SET status = 'FAILED' WHERE "attemptId" = '${payload.data.id}'`)).rejects.toThrow(/immutable/)
    expect(await prisma.auditEvent.findMany({ where: { ownerId: 'tenant-a', actorId: 'actor-a', objectType: { in: ['ReceivablesReminderDeliveryAttempt', 'ReceivablesReminderDeliveryResult'] } } })).toHaveLength(2)
  })

  it('Given concurrent transport retries with one durable approval, when they race against an idempotent provider, then one immutable attempt and one captured message win', async () => {
    const reminder = (await api.listReceivablesReminders('tenant-a'))[0]; const input = { recipient: 'concurrent@example.de', reason: 'Concurrent retry proof' }
    const [left, right] = await Promise.all([
      api.deliverReceivablesReminder('tenant-a', 'actor-a', reminder.id, 'delivery-concurrent-0001', input),
      api.deliverReceivablesReminder('tenant-a', 'actor-a', reminder.id, 'delivery-concurrent-0001', input),
    ])
    expect(left.id).toBe(right.id); expect(left.result).toMatchObject({ status: 'SENT' }); expect(right.result).toMatchObject({ status: 'SENT' })
    await expect(prisma.receivablesReminderDeliveryAttempt.count({ where: { ownerId: 'tenant-a', requestKey: 'delivery-concurrent-0001' } })).resolves.toBe(1)
    expect(capturedEmails.filter(item => item.idempotencyKey === left.id)).toHaveLength(1)
  })

  it('Given a provider failure, foreign tenant and subsequent operator retry, when deliveries are approved, then failure and success remain append-only and tenant scoped', async () => {
    const reminder = (await api.listReceivablesReminders('tenant-a'))[0]
    await expect(api.deliverReceivablesReminder('tenant-b', 'actor-b', reminder.id, 'delivery-foreign-0001', { recipient: 'billing@example.de', reason: 'Wrong tenant' })).rejects.toThrow(/does not belong/)
    const failed = await api.deliverReceivablesReminder('tenant-a', 'actor-a', reminder.id, 'delivery-failure-0001', { recipient: 'fail@example.de', reason: 'First approved attempt' })
    expect(failed.result).toMatchObject({ status: 'FAILED', failureCode: 'HTTP_503' })
    const retried = await api.deliverReceivablesReminder('tenant-a', 'actor-a', reminder.id, 'delivery-retry-000001', { recipient: 'billing@example.de', reason: 'Reviewed retry after provider recovery' })
    expect(retried.result).toMatchObject({ status: 'SENT' })
    expect(await prisma.receivablesReminderDeliveryAttempt.count({ where: { ownerId: 'tenant-a', reminderId: reminder.id } })).toBeGreaterThanOrEqual(4)
  })

  it('Given a provider call is in flight after its immutable attempt committed, when cancellation races before the result, then the migrated trigger serializes the state and cancellation cannot commit', async () => {
    const reminder = (await api.listReceivablesReminders('tenant-a'))[0]
    let markProviderStarted!: () => void; const providerStarted = new Promise<void>(resolve => { markProviderStarted = resolve })
    let releaseProvider!: () => void; const providerRelease = new Promise<void>(resolve => { releaseProvider = resolve })
    const blockingGateway = { send: vi.fn(async () => { markProviderStarted(); await providerRelease; return { status: 'SENT' as const, providerMessageId: 'serialized-provider-message' } }) }
    const delivery = api.deliverReceivablesReminder('tenant-a', 'actor-a', reminder.id, 'delivery-cancel-race-0001', { recipient: 'race@example.de', reason: 'Approved race proof' }, blockingGateway)
    await providerStarted
    await expect(api.cancelReceivablesReminder('tenant-a', 'actor-a', reminder.id, 'cancel-pending-race-0001', { cancelledOn: '2026-08-08', reason: 'Must wait for provider result' })).rejects.toThrow(/pending reminder delivery|constraint/i)
    expect(await prisma.receivablesReminderCancellation.findUnique({ where: { ownerId_reminderId: { ownerId: 'tenant-a', reminderId: reminder.id } } })).toBeNull()
    releaseProvider(); await expect(delivery).resolves.toMatchObject({ result: { status: 'SENT', providerMessageId: 'serialized-provider-message' } })
  })

  it('Given an issued reminder, when it is cancelled, then an append-only cancellation is added and the reminder remains printable', async () => {
    const reminder = (await api.listReceivablesReminders('tenant-a'))[0]
    await expect(api.cancelReceivablesReminder('tenant-b', 'actor-b', reminder.id, 'cancel-request-foreign', { cancelledOn: '2026-08-06', reason: 'Wrong tenant' })).rejects.toThrow(/does not belong/)
    const cancellationInput = { cancelledOn: '2026-08-06', reason: 'Customer already paid directly' }
    const [cancellation, replay] = await Promise.all([
      api.cancelReceivablesReminder('tenant-a', 'actor-a', reminder.id, 'cancel-request-0001', cancellationInput),
      api.cancelReceivablesReminder('tenant-a', 'actor-a', reminder.id, 'cancel-request-0001', cancellationInput),
    ])
    expect(replay.id).toBe(cancellation.id); expect(cancellation).toMatchObject({ reminderId: reminder.id, reason: 'Customer already paid directly' })
    await expect(prisma.receivablesReminderCancellation.count({ where: { ownerId: 'tenant-a', requestKey: 'cancel-request-0001' } })).resolves.toBe(1)
    expect(await api.getPrintableReceivablesReminder('tenant-a', reminder.id)).toMatchObject({ invoiceNumber: 'OPEN-1' })
    await expect(prisma.$executeRawUnsafe(`DELETE FROM ReceivablesReminderCancellation WHERE id = '${cancellation.id}'`)).rejects.toThrow(/immutable/)
    await expect(api.deliverReceivablesReminder('tenant-a', 'actor-a', reminder.id, 'delivery-after-cancel-0001', { recipient: 'billing@example.de', reason: 'Must reject cancelled reminder' })).rejects.toThrow(/cancelled reminder cannot be delivered/i)
  })

  it('Given a real migrated database and authenticated API, when a reminder is posted and downloaded, then the HTTP contract returns persisted safe HTML', async () => {
    const response = await postReminder(new Request('http://localhost/api/commercial/reminders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestKey: 'api-reminder-request-1', openItemId: 'oi-doc-overdue', issuedOn: '2026-08-07', paymentDueDate: '2026-08-14', reason: 'API proof' }) }))
    expect(response.status).toBe(201); const body = await response.json(); expect(body.data).toMatchObject({ level: 4, invoiceNumber: 'OPEN-1' })
    const download = await getPrint(new Request(`http://localhost/api/commercial/reminders/${body.data.id}/print?download=1`), { params: Promise.resolve({ id: body.data.id }) })
    expect(download.headers.get('content-disposition')).toContain('attachment'); expect(download.headers.get('content-security-policy')).toContain("default-src 'none'"); expect(await download.text()).toContain('keine E-Mail versandt')
  })
})
