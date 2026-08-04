import 'server-only'

export type ReminderEmailMessage = {
  idempotencyKey: string
  recipient: string
  subject: string
  textBody: string
  htmlBody: string
  attachment: { fileName: string; contentType: 'text/html; charset=utf-8'; contentBase64: string; sha256: string }
}

export type ReminderEmailGatewayResult =
  | { status: 'SENT'; providerMessageId: string }
  | { status: 'FAILED'; failureCode: string; failureMessage: string }

export interface ReminderEmailGateway {
  send(message: ReminderEmailMessage): Promise<ReminderEmailGatewayResult>
}

const safeFailure = (value: unknown, fallback: string) => typeof value === 'string' && value.trim() ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300) : fallback

export class HttpReminderEmailGateway implements ReminderEmailGateway {
  constructor(private readonly endpoint: string, private readonly credential: string, private readonly fetcher: typeof fetch = fetch) {}

  async send(message: ReminderEmailMessage): Promise<ReminderEmailGatewayResult> {
    let endpoint: URL
    try { endpoint = new URL(this.endpoint) } catch { return { status: 'FAILED', failureCode: 'CONFIGURATION_INVALID', failureMessage: 'The reminder email gateway URL is invalid.' } }
    const loopback = ['127.0.0.1', '::1', 'localhost'].includes(endpoint.hostname)
    if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) return { status: 'FAILED', failureCode: 'CONFIGURATION_INSECURE', failureMessage: 'The reminder email gateway must use HTTPS except on loopback.' }
    if (!this.credential.trim()) return { status: 'FAILED', failureCode: 'CONFIGURATION_MISSING', failureMessage: 'The reminder email gateway credential is not configured.' }
    try {
      const response = await this.fetcher(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.credential}`, 'idempotency-key': message.idempotencyKey },
        body: JSON.stringify({ version: 1, message: { to: [message.recipient], subject: message.subject, text: message.textBody, html: message.htmlBody }, attachments: [{ fileName: message.attachment.fileName, contentType: message.attachment.contentType, contentBase64: message.attachment.contentBase64, sha256: message.attachment.sha256 }] }),
        signal: AbortSignal.timeout(30_000),
      })
      const responseText = (await response.text()).slice(0, 32_000)
      let body: unknown
      try { body = responseText ? JSON.parse(responseText) : null } catch { body = null }
      if (!response.ok) return { status: 'FAILED', failureCode: `HTTP_${response.status}`, failureMessage: 'The outbound provider rejected the reminder delivery.' }
      const messageId = body && typeof body === 'object' && 'messageId' in body ? (body as { messageId?: unknown }).messageId : null
      if (typeof messageId !== 'string' || !messageId.trim() || messageId.length > 200 || /[\r\n]/.test(messageId)) return { status: 'FAILED', failureCode: 'INVALID_PROVIDER_RESPONSE', failureMessage: 'The outbound provider did not return a safe message ID.' }
      return { status: 'SENT', providerMessageId: messageId.trim() }
    } catch (error) {
      const code = error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'TRANSPORT_ERROR'
      return { status: 'FAILED', failureCode: code, failureMessage: safeFailure(error instanceof Error ? error.message : null, 'The outbound provider could not be reached.') }
    }
  }
}

export function configuredReminderEmailGateway(environment: NodeJS.ProcessEnv = process.env): ReminderEmailGateway {
  return new HttpReminderEmailGateway(environment.REMINDER_EMAIL_GATEWAY_URL ?? '', environment.REMINDER_EMAIL_GATEWAY_CREDENTIAL ?? '')
}
