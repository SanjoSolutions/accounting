import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3'
import { PrismaClient } from '../src/generated/prisma/client'
import { assertDisposableDatabasePath } from '../tools/db-safety.mjs'

export const syntheticUgEvidence = `SYNTHETIC TEST FIXTURE ONLY - not a real company or signed instrument.
2026 continuing standalone German micro UG; one shareholder who is sole managing director.
No statutory, articles-based or contractual independent review requirement in this fixture.
2025 approved synthetic closing balances / 2026 opening: bank EUR 900 debit,
commercial loss carryforward EUR 100 debit, subscribed capital EUR 1000 credit.
Prior statutory reserve zero. No assets, inventory, liabilities, contingent liabilities,
management loans, commitments or additional true-and-fair disclosures in this fixture.
2026 recognized non-VAT income EUR 119 received in bank. Result after all fixture expenses/taxes EUR 119.
No accrual, provision, valuation or subsequent-event adjustments. Cut-off tested to 15 Jan 2027;
events assessed to 1 Feb 2027; cash forecast supports going concern through 31 Dec 2027.
GKV cost policy. Current assets EUR 1019; previous assets EUR 900. No employees.
Resolution fixture: loss carryforward EUR 100 offsets result EUR 119; §5a reserve EUR 4.75;
EUR 14.25 carried forward; no distribution, no reserve release, no capital change.
Synthetic signature and sole-shareholder resolution dated 1 February 2027.
This tests commercial annual accounts only, not tax-loss utilization or tax filing.`

export async function seedSyntheticUgOpening(ownerId: string, evidenceId: string, baseURL: string) {
  if (baseURL !== 'http://127.0.0.1:3110') throw new Error('UG fixture requires isolated port 3110.')
  const databasePath = assertDisposableDatabasePath('ug-close-playwright.db', { cwd: process.cwd(), env: { NODE_ENV: 'test', E2E_DATABASE_FILE: 'ug-close-playwright.db', DISPOSABLE_DATABASE: 'true' } })
  if (databasePath !== resolve('ug-close-playwright.db')) throw new Error('Unexpected disposable database.')
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${databasePath.replaceAll('\\', '/')}` }) })
  try {
    const bank = await db.ledgerAccount.findFirstOrThrow({ where: { ownerId, number: 1200 } })
    const revenue = await db.ledgerAccount.findFirstOrThrow({ where: { ownerId, number: 8400 } })
    const capital = await db.ledgerAccount.findFirstOrThrow({ where: { ownerId, number: 2900 } })
    const carry = await db.ledgerAccount.create({ data: { ownerId, number: 2991, name: 'Synthetic commercial result carryforward', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity' } })
    const reserve = await db.ledgerAccount.create({ data: { ownerId, number: 2992, name: 'Synthetic UG statutory reserve', category: 'EQUITY', eBilanzPosition: 'bs.eqLiab.equity' } })
    const openingLines = [{ accountId: bank.id, debitCents: 90000, creditCents: 0 }, { accountId: carry.id, debitCents: 10000, creditCents: 0 }, { accountId: capital.id, debitCents: 0, creditCents: 100000 }]
    for (const year of [2025, 2026]) {
      const period = await db.fiscalYear.findUniqueOrThrow({ where: { ownerId_year: { ownerId, year } } })
      await db.journalEntry.create({ data: { ownerId, fiscalYearId: period.id, sequenceNumber: 1, bookingDate: new Date(`${year}-01-01`), documentNumber: `SYNTHETIC-OPENING-${year}`, description: 'Documented synthetic opening balances', source: 'OPENING', lines: { create: openingLines }, documents: { create: [{ documentId: evidenceId }] } } })
      if (year === 2025) await db.fiscalYear.update({ where: { id: period.id }, data: { status: 'CLOSED', lockedAt: new Date('2026-02-01') } })
      else await db.journalEntry.create({ data: { ownerId, fiscalYearId: period.id, sequenceNumber: 2, bookingDate: new Date('2026-12-15'), documentNumber: 'SYNTHETIC-INCOME-2026', description: 'Synthetic non-VAT income after all fixture expenses and taxes', source: 'MANUAL', lines: { create: [{ accountId: bank.id, debitCents: 11900, creditCents: 0 }, { accountId: revenue.id, debitCents: 0, creditCents: 11900 }] }, documents: { create: [{ documentId: evidenceId }] } } })
    }
    return { capitalAccountId: capital.id, carryforwardAccountId: carry.id, reserveAccountId: reserve.id, openingFingerprint: createHash('sha256').update(JSON.stringify([{ account: 1200, debit: 90000 }, { account: 2991, debit: 10000 }, { account: 2900, credit: 100000 }])).digest('hex') }
  } finally { await db.$disconnect() }
}
