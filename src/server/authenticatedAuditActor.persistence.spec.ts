import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import type { Prisma } from '@/generated/prisma/client'

const session = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/server/auth', () => ({ auth: { api: { getSession: session.getSession } } }))
// Attribution tests use a persisted approved run; HGB readiness has its own suite.
// Routes, membership authorization, business writes, storage and audit signing are real.
vi.mock('@/server/hgbCloseRepository', () => ({
  requireCurrentReadyHgbClose: (client: Prisma.TransactionClient, ownerId: string, fiscalYear: { id: string }) =>
    client.hgbCloseRun.findFirstOrThrow({ where: { ownerId, fiscalPeriodId: fiscalYear.id, status: 'READY_TO_LOCK' } }),
}))

const directory = mkdtempSync(join(tmpdir(), 'accounting-audit-actor-'))
let prisma: typeof import('./persistence/client').prisma
let ledger: typeof import('./ledger')
let batches: typeof import('./bookingBatches')
let audit: typeof import('./compliance/auditPersistence')
let upload: typeof import('@/app/api/documents/route').POST
let postBatch: typeof import('@/app/api/booking-batches/[id]/post/route').POST
let adjustment: typeof import('@/app/api/tax/annual/adjustments/route').POST
let issue: typeof import('@/app/api/tax/e-invoices/route').POST
let correct: typeof import('@/app/api/tax/e-invoices/[id]/corrections/route').POST
let correctionTemplate: typeof import('@/app/api/tax/e-invoices/[id]/corrections/route').GET
let close: typeof import('@/app/api/fiscal-years/[year]/close/route').POST
let exportBalance: typeof import('@/app/api/fiscal-years/[year]/e-balance/route').POST

beforeAll(async () => {
  const databasePath = join(directory, 'test.db').replace(/\\/g, '/')
  const database = new DatabaseSync(databasePath)
  // This empty, disposable fixture needs schema fidelity, not crash durability.
  database.exec('PRAGMA synchronous = OFF')
  const migrations = resolve('prisma/migrations')
  for (const name of readdirSync(migrations, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).sort()) {
    database.exec(readFileSync(join(migrations, name, 'migration.sql'), 'utf8'))
  }
  database.close()
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`)
  vi.stubEnv('DOCUMENT_STORAGE_DRIVER', 'fs')
  vi.stubEnv('DOCUMENT_STORAGE_ROOT', join(directory, 'documents'))
  vi.stubEnv('DOCUMENT_STORAGE_OPTIONS', '{}')
  vi.stubEnv('COMPLIANCE_E2E_REFERENCE_DATE', '2027-01-02')
  prisma = (await import('./persistence/client')).prisma
  ledger = await import('./ledger')
  batches = await import('./bookingBatches')
  audit = await import('./compliance/auditPersistence')
  upload = (await import('@/app/api/documents/route')).POST
  postBatch = (await import('@/app/api/booking-batches/[id]/post/route')).POST
  adjustment = (await import('@/app/api/tax/annual/adjustments/route')).POST
  issue = (await import('@/app/api/tax/e-invoices/route')).POST
  correct = (await import('@/app/api/tax/e-invoices/[id]/corrections/route')).POST
  correctionTemplate = (await import('@/app/api/tax/e-invoices/[id]/corrections/route')).GET
  close = (await import('@/app/api/fiscal-years/[year]/close/route')).POST
  exportBalance = (await import('@/app/api/fiscal-years/[year]/e-balance/route')).POST
})

afterAll(async () => {
  await prisma?.$disconnect()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

// Request objects are passed directly to handlers. No HTTP server or browser is used.
function request(ownerId: string, body?: unknown) {
  return new Request('http://localhost:3125/api/audit-actor-test', {
    method: 'POST', headers: { cookie: `accounting-tenant=${ownerId}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
async function json(response: Response, status = 201) {
  const body = await response.json()
  expect(response.status, JSON.stringify(body)).toBe(status)
  return body
}
async function expectEvent(ownerId: string, actorId: string, action: string) {
  const events = await prisma.auditEvent.findMany({ where: { ownerId, action } })
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ ownerId, actorId, action })
  return events[0]
}

describe('authenticated actor propagation through routes and migrated persistence', () => {
  test.each([
    { mode: 'delegated accountant', ownerId: 'audit-tenant', actorId: 'audit-accountant', authMode: 'credentials' },
    { mode: 'owner', ownerId: 'audit-owner', actorId: 'audit-owner', authMode: 'credentials' },
    { mode: 'local solo', ownerId: 'local', actorId: 'local', authMode: 'none' },
  ])('Given a $mode, when audited tenant operations complete, then every event keeps the tenant and actual actor', async ({ ownerId, actorId, authMode }) => {
    vi.stubEnv('AUTH_MODE', authMode)
    const user = await prisma.user.create({ data: { id: actorId, name: actorId, email: `${actorId}@example.test` } })
    session.getSession.mockResolvedValue({ user })
    if (ownerId !== actorId) await prisma.tenantMembership.create({ data: { ownerId, userId: actorId, role: 'ACCOUNTANT' } })
    const workspace = await ledger.getLedgerWorkspace(ownerId, 2026)
    const account = (number: number) => workspace.accounts.find(item => item.number === number)!.id

    // A historical owner-attributed signed event must stay byte-for-byte unchanged.
    const historical = await prisma.$transaction(transaction => audit.appendAuditEvent(transaction, {
      ownerId, actorId: ownerId, action: 'ARTIFACT_REGISTERED', reason: 'Historical attribution fixture',
      objectType: 'Document', objectId: `historical-${ownerId}`,
    }))
    const before = await prisma.auditEvent.findMany({ where: { ownerId } })
    const uploaded = await json(await upload(new Request('http://localhost:3125/api/documents', {
      method: 'POST', headers: { cookie: `accounting-tenant=${ownerId}`, 'content-type': 'application/xml', 'x-document-file-name': 'evidence.xml' },
      body: '<Evidence>synthetic audit fixture</Evidence>',
    })))
    const registered = await prisma.auditEvent.findMany({ where: { ownerId, action: 'ARTIFACT_REGISTERED', objectId: uploaded.data.id } })
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ ownerId, actorId })
    expect(await prisma.documentRecord.findUniqueOrThrow({ where: { id: uploaded.data.id } })).toMatchObject({ ownerId })

    const draft = await batches.createBookingBatch(ownerId, actorId, {
      fiscalYear: 2026, bookingDate: '2026-08-01', description: 'Synthetic evidence booking', documentIds: [uploaded.data.id],
      lines: [{ accountId: account(1000), debitCents: 1000, creditCents: 0 }, { accountId: account(4930), debitCents: 0, creditCents: 1000 }],
    })
    const posted = await json(await postBatch(request(ownerId), { params: Promise.resolve({ id: draft.id }) }), 200)
    expect(await expectEvent(ownerId, actorId, 'JOURNAL_ENTRY_POSTED')).toMatchObject({ objectId: posted.id })
    await expectEvent(ownerId, actorId, 'JOURNAL_DRAFT_POSTED')

    await json(await adjustment(request(ownerId, { year: 2026, actorId: 'forged-actor', adjustment: {
      id: `adjustment-${ownerId}`, ruleVersion: 'test-v1', field: 'test-add-back', layer: 'income-tax', amountCents: 100,
      reason: 'Synthetic adjustment', sourceDocumentIds: [uploaded.data.id], legalBasis: 'Test evidence', treatment: 'add-back',
    } })))
    await expectEvent(ownerId, actorId, 'ANNUAL_TAX_ADJUSTMENT_RECORDED')

    await prisma.accountRecord.create({ data: { id: `company:${ownerId}`, ownerId, payload: JSON.stringify({
      invoiceIssuer: { name: 'Synthetic GmbH', streetAndHouseNumber: 'Testweg 1', zipCode: '10115', city: 'Berlin', country: 'DE', contactName: 'Accounts', contactTelephone: '+49 30 123456', contactEmail: 'billing@example.test' },
      companyProfile: { companyName: 'Synthetic GmbH', taxNumber: '1234567890123', vatId: 'DE123456789', legalForm: 'GMBH', taxOffice: 'Berlin', activity: 'Consulting', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', sizeClass: 'SMALL', chart: 'SKR03', elections: [] },
    }) } })
    await json(await issue(request(ownerId, { action: 'configure-number-sequence', year: 2026, firstUnusedNumber: 1, confirmedExistingSeries: true })))
    const invoiceInput = {
      issueDate: '2026-08-04', supplyDate: '2026-08-04', dueDate: '2026-08-18', currency: 'EUR',
      netAmountCents: 10000, taxAmountCents: 1900, grossAmountCents: 11900, payableAmountCents: 11900,
      buyer: { name: 'Synthetic Buyer GmbH', street: 'Testweg 2', postalCode: '10115', city: 'Berlin', countryCode: 'DE', vatId: 'DE987654321' },
      lines: [{ description: 'Synthetic consulting', quantity: 1, unitCode: 'C62', netAmountCents: 10000, taxRateBasisPoints: 1900, taxCategoryCode: 'S' }],
      buyerReference: 'TEST-REFERENCE', buyerElectronicAddress: { schemeId: '9930', value: 'DE987654321' },
      paymentTerms: 'Payable within 14 days.', paymentIban: 'DE89370400440532013000',
    }
    const invoice = await json(await issue(request(ownerId, { ...invoiceInput, kind: 'invoice', requestKey: `issue-${ownerId}-request` })))
    const template = await json(await correctionTemplate(request(ownerId), { params: Promise.resolve({ id: invoice.data.id }) }), 200)
    const corrected = await json(await correct(request(ownerId, { ...invoiceInput, buyer: template.data.data.buyer, kind: 'credit-note', requestKey: `credit-${ownerId}-request` }), { params: Promise.resolve({ id: invoice.data.id }) }))
    await expectEvent(ownerId, actorId, 'OUTGOING_CREDIT_NOTE_POSTED')
    const commercial = await prisma.commercialDocument.findFirstOrThrow({ where: { ownerId, structuredInvoiceId: corrected.data.id }, include: { correctionNetting: true } })
    expect(commercial.correctionNetting).toMatchObject({ ownerId, createdBy: actorId })

    await prisma.hgbCloseRun.create({ data: {
      ownerId, fiscalPeriodId: workspace.fiscalYear.id, version: 1, status: 'READY_TO_LOCK', ruleSetVersion: 'test',
      ledgerFingerprint: 'test', inputChecksum: 'test', checksum: `approved-${ownerId}`, payload: '{}', createdBy: actorId,
    } })
    await json(await close(request(ownerId), { params: Promise.resolve({ year: '2026' }) }), 200)
    await expectEvent(ownerId, actorId, 'FISCAL_PERIOD_CLOSED')
    const masterData = { companyName: 'Synthetic GmbH', street: 'Testweg 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'GMBH' }
    const exported = await exportBalance(request(ownerId, masterData), { params: Promise.resolve({ year: '2026' }) })
    expect(exported.status, exported.status !== 200 ? await exported.text() : '').toBe(200)
    expect(exported.headers.get('content-type')).toBe('application/zip')
    await expectEvent(ownerId, actorId, 'E_BILANZ_EXPORTED')
    expect(await prisma.eBalanceLifecycleReport.findFirstOrThrow({ where: { ownerId } })).toMatchObject({ ownerId, createdBy: actorId })

    expect(await prisma.auditEvent.findMany({ where: { id: { in: before.map(event => event.id) } } })).toEqual(before)
    expect(await prisma.auditEvent.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical)
    const events = await prisma.auditEvent.findMany({ where: { ownerId } })
    const head = await prisma.auditHead.findUniqueOrThrow({ where: { ownerId } })
    expect(audit.verifyAuditChain(events, head)).toBe(true)
    expect(events.filter(event => event.id !== historical.id).every(event => event.actorId === actorId)).toBe(true)
    if (ownerId !== actorId) expect(await prisma.auditEvent.count({ where: { ownerId: actorId } })).toBe(0)
  }, 30_000)

  test.each([
    { mode: 'anonymous request', expectedStatus: 401 },
    { mode: 'read-only delegate', expectedStatus: 403 },
  ])('Given an $mode, when an affected write route is called, then it rejects before persistence', async ({ mode, expectedStatus }) => {
    vi.stubEnv('AUTH_MODE', 'credentials')
    const ownerId = 'denied-audit-tenant'
    if (mode === 'anonymous request') session.getSession.mockResolvedValue(null)
    else {
      const user = await prisma.user.create({ data: { id: 'audit-reader', name: 'Reader', email: 'reader@example.test' } })
      await prisma.tenantMembership.create({ data: { ownerId, userId: user.id, role: 'READ_ONLY' } })
      session.getSession.mockResolvedValue({ user })
    }
    const routes = [
      () => upload(request(ownerId, {})),
      () => postBatch(request(ownerId, {}), { params: Promise.resolve({ id: 'missing-draft' }) }),
      () => adjustment(request(ownerId, {})),
      () => correct(request(ownerId, {}), { params: Promise.resolve({ id: 'missing-invoice' }) }),
      () => close(request(ownerId, {}), { params: Promise.resolve({ year: '2026' }) }),
      () => exportBalance(request(ownerId, {}), { params: Promise.resolve({ year: '2026' }) }),
    ]
    for (const route of routes) expect((await route()).status).toBe(expectedStatus)
    expect(await prisma.auditEvent.count({ where: { ownerId } })).toBe(0)
    expect(await prisma.fiscalYear.count({ where: { ownerId } })).toBe(0)
    expect(await prisma.documentRecord.count({ where: { ownerId } })).toBe(0)
  })
})
