import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { HttpReminderEmailGateway, type ReminderEmailMessage } from './reminderEmailGateway'

const message: ReminderEmailMessage = { idempotencyKey: 'attempt-123456789', recipient: 'billing@example.de', subject: 'Zahlungserinnerung', textBody: 'Text', htmlBody: '<p>Text</p>', attachment: { fileName: 'Zahlungserinnerung-R-1.html', contentType: 'text/html; charset=utf-8', contentBase64: 'PCFkb2N0eXBlIGh0bWw+', sha256: 'a'.repeat(64) } }

describe('reminder email HTTP gateway contract', () => {
  it('Given a configured HTTPS provider, when it accepts a message, then the explicit recipient, idempotency key and safe attachment cross the real provider contract', async () => {
    const fetcher = vi.fn(async (_url: URL, init?: RequestInit) => new Response(JSON.stringify({ messageId: 'provider-message-1' }), { status: 202 }))
    const result = await new HttpReminderEmailGateway('https://mail.example.test/reminders', 'secret', fetcher as typeof fetch).send(message)
    expect(result).toEqual({ status: 'SENT', providerMessageId: 'provider-message-1' })
    const init = fetcher.mock.calls[0]![1]!; expect(init.headers).toMatchObject({ authorization: 'Bearer secret', 'idempotency-key': message.idempotencyKey })
    expect(JSON.parse(String(init.body))).toMatchObject({ version: 1, message: { to: ['billing@example.de'] }, attachments: [{ contentType: 'text/html; charset=utf-8', sha256: 'a'.repeat(64) }] })
  })
  it.each([
    ['remote plain HTTP', 'http://mail.example.test', 'credential', 'CONFIGURATION_INSECURE'],
    ['missing credential', 'https://mail.example.test', '', 'CONFIGURATION_MISSING'],
  ])('Given %s, when delivery is attempted, then it fails closed before transport', async (_label, endpoint, credential, failureCode) => {
    const fetcher = vi.fn(); const result = await new HttpReminderEmailGateway(endpoint, credential, fetcher as typeof fetch).send(message)
    expect(result).toMatchObject({ status: 'FAILED', failureCode }); expect(fetcher).not.toHaveBeenCalled()
  })
  it('Given a provider failure, when the gateway responds, then a bounded non-secret failure is returned for an operator retry', async () => {
    const result = await new HttpReminderEmailGateway('http://127.0.0.1:3999', 'secret', vi.fn(async () => new Response('internal secret body', { status: 503 })) as typeof fetch).send(message)
    expect(result).toEqual({ status: 'FAILED', failureCode: 'HTTP_503', failureMessage: 'The outbound provider rejected the reminder delivery.' })
  })
})
