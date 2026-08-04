import { expect, type Page } from '@playwright/test'

export class BankingPage {
  constructor(private readonly page: Page) {}

  async open() {
    await this.page.getByRole('link', { name: 'Bank', exact: true }).click()
    await expect(this.page).toHaveURL('/banking'); await expect(this.page.getByRole('heading', { name: 'Bank statement review' })).toBeVisible()
  }

  async configureAccount() {
    await this.page.getByLabel('Bank account name').fill('Hausbank')
    await this.page.getByLabel('German IBAN').fill('DE44 5001 0517 5407 3249 31')
    await this.page.getByLabel('Ledger bank account').selectOption({ index: 0 })
    await this.page.getByRole('button', { name: 'Create bank account' }).click()
    await expect(this.page.getByRole('status')).toContainText('bank account was created')
  }

  statement() {
    return Buffer.from(`<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>E2E-STMT-2026-08</Id><FrToDt><FrDtTm>2026-08-01T00:00:00Z</FrDtTm><ToDtTm>2026-08-31T23:59:59Z</ToDtTm></FrToDt><Acct><Id><IBAN>DE44500105175407324931</IBAN></Id></Acct><Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal><Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1059.50</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal><Ntry><Amt Ccy="EUR">59.50</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-08-04</Dt></BookgDt><NtryRef>E2E-BANK-REF-1</NtryRef><NtryDtls><TxDtls><Refs><AcctSvcrRef>E2E-BANK-REF-1</AcctSvcrRef></Refs><RltdPties><Dbtr><Nm>Kunde GmbH</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Invoice 2026-000001</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`)
  }

  splitOverpaymentStatement() {
    return Buffer.from(`<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>E2E-STMT-SPLIT-OVERPAY</Id><FrToDt><FrDtTm>2026-08-01T00:00:00Z</FrDtTm><ToDtTm>2026-08-31T23:59:59Z</ToDtTm></FrToDt><Acct><Id><IBAN>DE44500105175407324931</IBAN></Id></Acct><Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal><Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1250.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal><Ntry><Amt Ccy="EUR">250.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-08-04</Dt></BookgDt><NtryRef>E2E-BANK-SPLIT-OVERPAY</NtryRef><NtryDtls><TxDtls><Refs><AcctSvcrRef>E2E-BANK-SPLIT-OVERPAY</AcctSvcrRef></Refs><RltdPties><Dbtr><Nm>Kunde GmbH</Nm></Dbtr></RltdPties><RmtInf><Ustrd>Invoices 2026-000001 and 2026-000002</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry></Stmt></BkToCstmrStmt></Document>`)
  }

  async importSplitOverpaymentAndReview() {
    await this.page.getByLabel('CAMT.053 XML statement').setInputFiles({ name: 'split-overpayment.xml', mimeType: 'application/xml', buffer: this.splitOverpaymentStatement() })
    await this.page.getByRole('button', { name: 'Import statement' }).click()
    await expect(this.page.getByRole('status')).toContainText('Imported 1 new transactions; skipped 0 duplicates.')
    const row = this.page.getByRole('row', { name: /2026-08-04.*Kunde GmbH.*2026-000001 and 2026-000002.*€250.00.*Unmatched/ })
    await expect(row).toBeVisible(); await row.getByRole('button', { name: /Review allocation.*2 invoices/ }).click()
    const review = this.page.getByRole('region', { name: 'Posting review' })
    await expect(review.getByRole('row', { name: /2026-000001.*Kunde GmbH.*€119.00/ })).toBeVisible()
    await expect(review.getByRole('row', { name: /2026-000002.*Kunde GmbH.*€119.00/ })).toBeVisible()
    await expect(review.getByText('Unallocated customer/supplier credit retained: €12.00')).toBeVisible()
  }

  async confirmSplitOverpaymentAndProvePersistence() {
    await this.page.getByRole('button', { name: 'Confirm and post' }).click()
    await expect(this.page.getByRole('status')).toContainText('split across 2 open items, and retained €12.00 credit atomically')
    const matched = this.page.getByRole('row', { name: /2026-08-04.*Kunde GmbH.*2026-000001 and 2026-000002.*€250.00.*Matched.*2 invoices.*€12.00/ })
    await expect(matched).toBeVisible()
    await this.page.reload(); await expect(matched).toBeVisible()
    await this.page.getByRole('link', { name: 'Customers & open items' }).click()
    await expect(this.page.getByRole('row', { name: /2026-000001.*Kunde GmbH.*€119.00.*€0.00.*SETTLED/ })).toBeVisible()
    await expect(this.page.getByRole('row', { name: /2026-000002.*Kunde GmbH.*€119.00.*€0.00.*SETTLED/ })).toBeVisible()
    await this.page.getByRole('link', { name: 'Journal', exact: true }).click()
    const journal = this.page.locator('article').filter({ hasText: 'Bank payment 2026-000001, 2026-000002' })
    await expect(journal).toContainText('1200 · Bank'); await expect(journal).toContainText(/Soll.*250,00/)
    await expect(journal).toContainText('1400 · Forderungen'); await expect(journal).toContainText(/Haben.*250,00/)
  }

  async importAndReview() {
    const upload = { name: 'statement.xml', mimeType: 'application/xml', buffer: this.statement() }
    await this.page.getByLabel('CAMT.053 XML statement').setInputFiles(upload)
    await this.page.getByRole('button', { name: 'Import statement' }).click()
    await expect(this.page.getByRole('status')).toContainText('Imported 1 new transactions; skipped 0 duplicates.')
    const row = this.page.getByRole('row', { name: /2026-08-04.*Kunde GmbH.*Invoice 2026-000001.*€59.50.*Unmatched/ })
    await expect(row).toBeVisible(); await row.getByRole('button', { name: /Review allocation.*1 invoice/ }).click()
    await expect(this.page.getByRole('heading', { name: 'Posting review' })).toBeVisible()
    await expect(this.page.getByRole('alert').filter({ hasText: 'no journal entry or settlement has been created' })).toBeVisible()
  }

  async confirmAndProvePosting() {
    const confirmation = this.page.waitForResponse(response => /\/api\/banking\/transactions\/[^/]+\/matches$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST')
    await this.page.getByRole('button', { name: 'Confirm and post' }).click()
    const confirmed = await confirmation; const confirmedBody = await confirmed.json(); const request = confirmed.request(); const idempotencyKey = request.headers()['idempotency-key']; const requestBody = request.postData()!
    await expect(this.page.getByRole('status')).toContainText('split across 1 open item, and retained €0.00 credit atomically')
    await expect(this.page.getByRole('row', { name: /2026-08-04.*Kunde GmbH.*2026-000001.*Matched.*Reverse match/ })).toBeVisible()
    const replay = await this.page.evaluate(async ({ url, idempotencyKey, requestBody }) => { const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: requestBody }); return { status: response.status, body: await response.json() } }, { url: new URL(confirmed.url()).pathname, idempotencyKey, requestBody })
    expect(replay.status).toBe(201); expect(replay.body.data.id).toBe(confirmedBody.data.id)
    await this.page.getByRole('link', { name: 'Customers & open items' }).click()
    await expect(this.page.getByRole('row', { name: /2026-000001.*Kunde GmbH.*€119.00.*€59.50.*PARTIAL/ })).toBeVisible()
    await this.page.getByRole('link', { name: 'Journal', exact: true }).click()
    const journal = this.page.locator('article').filter({ hasText: 'Bank payment 2026-000001' })
    await expect(journal).toContainText('1200 · Bank'); await expect(journal).toContainText(/Soll.*59,50/); await expect(journal).toContainText('1400 · Forderungen'); await expect(journal).toContainText(/Haben.*59,50/)
  }

  async provePersistenceAndDeduplication() {
    await this.page.getByRole('link', { name: 'Bank', exact: true }).click(); await expect(this.page).toHaveURL('/banking'); await this.page.reload(); await expect(this.page.getByRole('row', { name: /2026-08-04.*Kunde GmbH.*2026-000001.*Matched.*Reverse match/ })).toBeVisible()
    await this.page.getByLabel('CAMT.053 XML statement').setInputFiles({ name: 'statement.xml', mimeType: 'application/xml', buffer: this.statement() })
    await this.page.getByRole('button', { name: 'Import statement' }).click()
    await expect(this.page.getByRole('status')).toContainText('Imported 0 new transactions; skipped 1 duplicates.')
    await expect(this.page.getByRole('row', { name: /2026-08-04.*Kunde GmbH.*2026-000001.*Matched/ })).toHaveCount(1)
  }

  async reverseAndProveAppendOnlyCorrection() {
    await this.page.getByRole('row', { name: /2026-08-04.*Kunde GmbH.*2026-000001.*Matched/ }).getByRole('button', { name: 'Reverse match' }).click()
    await expect(this.page.getByRole('status')).toContainText('append-only history')
    await expect(this.page.getByRole('row', { name: /2026-08-04.*Kunde GmbH.*2026-000001.*Reversed.*Review allocation/ })).toBeVisible()
    await this.page.getByRole('link', { name: 'Customers & open items' }).click()
    await expect(this.page.getByRole('row', { name: /2026-000001.*Kunde GmbH.*€119.00.*€119.00.*OPEN/ })).toBeVisible()
    await this.page.getByRole('link', { name: 'Journal', exact: true }).click()
    const reversal = this.page.locator('article').filter({ hasText: /Reversal of BANK-/ })
    await expect(reversal).toContainText('1200 · Bank'); await expect(reversal).toContainText(/Haben.*59,50/); await expect(reversal).toContainText('1400 · Forderungen'); await expect(reversal).toContainText(/Soll.*59,50/)
  }
}
