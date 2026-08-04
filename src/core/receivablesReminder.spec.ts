import { describe, expect, it } from 'vitest'
import { assertReminderEligible, nextReminderLevel, normalizeReminderRecipient, ReceivablesReminderError, renderReminderDeliveryContent, renderReminderHtml } from './receivablesReminder'

const eligible = { tenantId: 'a', openItemTenantId: 'a', direction: 'RECEIVABLE', kind: 'INVOICE', documentStatus: 'FINAL', status: 'PARTIAL', dueDate: '2026-07-01', issuedOn: '2026-08-04', originalAmountCents: 10_000, allocatedAmountCents: 2_000 }

describe('receivables reminder policy', () => {
  it('Given a tenant customer invoice with a positive overdue balance, when eligibility is derived, then the exact remaining cents are returned', () => expect(assertReminderEligible(eligible)).toBe(8_000))
  it('Given a posted customer invoice, when eligibility is derived, then the persisted posted status is supported', () => expect(assertReminderEligible({ ...eligible, documentStatus: 'POSTED' })).toBe(8_000))
  it.each([
    ['foreign tenant', { openItemTenantId: 'b' }], ['payable', { direction: 'PAYABLE' }], ['credit note', { kind: 'CREDIT_NOTE' }], ['draft invoice', { documentStatus: 'DRAFT' }], ['corrected invoice', { documentStatus: 'CORRECTED' }], ['settled item', { status: 'SETTLED' }], ['zero balance', { allocatedAmountCents: 10_000 }], ['not due', { dueDate: '2026-08-04' }],
  ])('Given a %s, when reminder eligibility is checked, then it fails closed', (_label, patch) => expect(() => assertReminderEligible({ ...eligible, ...patch })).toThrow(ReceivablesReminderError))
  it('Given prior reminder levels, when the next level is derived, then it is sequential', () => expect(nextReminderLevel([1, 2])).toBe(3))
  it('Given untrusted snapshot text, when printable HTML is rendered, then active markup is escaped and manual-send scope is explicit', () => {
    const html = renderReminderHtml({ level: 1, issuedOn: '2026-08-04', paymentDueDate: '2026-08-11', originalDueDate: '2026-07-01', remainingAmountCents: 100, currency: 'EUR', invoiceNumber: '<script>alert(1)</script>', partnerName: '<img src=x>', issuerName: 'UG & Co' })
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).toContain('keine E-Mail versandt'); expect(html).toContain('kein gerichtliches Mahnverfahren')
  })
  it('Given an operator-entered customer address, when it is approved for delivery, then it is normalized without inferring an address', () => expect(normalizeReminderRecipient(' Billing.Customer@Example.DE ')).toBe('billing.customer@example.de'))
  it.each(['', 'customer', 'customer@localhost', 'victim@example.de\r\nBcc: attacker@example.test'])('Given an unsafe or incomplete address %s, when delivery is requested, then it fails closed', value => expect(() => normalizeReminderRecipient(value)).toThrow(ReceivablesReminderError))
  it('Given immutable reminder facts containing markup, when delivery content is derived, then fixed text and HTML are escaped', () => {
    const content = renderReminderDeliveryContent({ invoiceNumber: 'R-1<script>', level: 2, issuerName: 'Example <UG>' })
    expect(content.subject).toBe('Zahlungserinnerung zu Rechnung R-1<script>')
    expect(content.textBody).toContain('HTML-Datei beigefügt')
    expect(content.htmlBody).not.toContain('<script>'); expect(content.htmlBody).toContain('&lt;UG&gt;')
  })
  it('Given immutable text containing header delimiters, when delivery content is derived, then subject and bodies cannot inject another mail header', () => {
    const content = renderReminderDeliveryContent({ invoiceNumber: 'R-1\r\nBcc: attacker@example.test', level: 1, issuerName: 'Example UG' })
    expect(content.subject).not.toMatch(/[\r\n]/); expect(content.subject).toContain('Bcc: attacker@example.test')
  })
})
