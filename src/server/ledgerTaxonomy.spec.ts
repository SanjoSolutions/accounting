import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFinancialStatements, type LedgerBalance } from '@/core/doubleEntry'
import { createEBalanceXbrl, getEBalanceTaxonomy } from '@/core/eBilanz'
import { validateEBalanceConcepts } from '@/core/eBilanzPackage'

vi.mock('server-only', () => ({}))
vi.mock('./persistence/client', () => ({ prisma: {} }))
import { DEFAULT_ACCOUNTS, defaultAccountsForLedger, getEBalanceBlockingIssues, mergeSubmissionHistory, normalizeDocumentIds, submissionResultStatus, validateDocumentNamespace } from './ledger'

describe('default ledger taxonomy mappings', () => {
  it('scales SKR03 defaults to the persisted DATEV account length', () => {
    const numbers = defaultAccountsForLedger('SKR03', 5).map(([number]) => number)
    expect(numbers).toContain(12000)
    expect(numbers).toContain(84000)
    expect(numbers).not.toContain(1200)
    expect(defaultAccountsForLedger('SKR04', 4)).toEqual([])
  })

  it('supports zero to many unique document attachments', () => {
    expect(normalizeDocumentIds({})).toEqual([])
    expect(normalizeDocumentIds({ documentIds: ['one', 'two', 'one'] })).toEqual(['one', 'two'])
    expect(() => normalizeDocumentIds({ documentIds: [''] })).toThrow('ausgewählten Belege')
  })
  it('never records an unsent binding attempt as accepted or merely valid', () => {
    expect(submissionResultStatus(true, false)).toBe('REJECTED')
    expect(submissionResultStatus(true, true)).toBe('ACCEPTED')
    expect(submissionResultStatus(false, false)).toBe('VALID')
  })
  it('retains relevant and matching submissions outside the display-history limit', () => {
    const recent = [{ id: 'recent', createdAt: new Date('2026-02-01') }]
    const active = [{ id: 'active', createdAt: new Date('2026-01-01') }]
    const matching = { id: 'matching', createdAt: new Date('2025-12-01') }
    expect(mergeSubmissionHistory(recent, active, matching).map(item => item.id)).toEqual(['recent', 'active', 'matching'])
  })
  it('reserves automatic opening document numbers from manual postings', () => {
    expect(() => validateDocumentNamespace('MANUAL', 'SYS-EB-2026')).toThrow('Systembuchungen reserviert')
    expect(() => validateDocumentNamespace('OPENING', 'SYS-EB-2026')).not.toThrow()
  })
  it('does not block reporting for a closed year merely because a successor is already closed', () => {
    const successor = 'Das bereits abgeschlossene Folgejahr 2026 verhindert einen nachträglichen Abschluss.'
    expect(getEBalanceBlockingIssues('CLOSED', [successor])).toEqual([])
    expect(getEBalanceBlockingIssues('OPEN', [successor])).toEqual([successor])
  })

  it('resolves every built-in mapping and generated GCD fact in official taxonomy 6.9', async () => {
    const balances: LedgerBalance[] = DEFAULT_ACCOUNTS.map(([number, name, category, eBilanzPosition], index) => ({
      accountId: String(number), number, name, category,
      eBilanzPosition,
      debitCents: category === 'ASSET' || category === 'EXPENSE' ? index + 1 : 0,
      creditCents: category === 'ASSET' || category === 'EXPENSE' ? 0 : index + 1,
      balanceCents: category === 'ASSET' || category === 'EXPENSE' ? index + 1 : -(index + 1),
    }))
    const taxonomy = getEBalanceTaxonomy(2026)
    const xml = createEBalanceXbrl({
      name: 'Test GmbH', street: 'Musterstraße 1', postalCode: '10115', city: 'Berlin', taxNumber: '1234567890123', legalForm: 'GMBH', fiscalYear: 2026,
      fiscalYearStart: '2026-01-01', fiscalYearEnd: '2026-12-31', taxonomyVersion: taxonomy.version,
      gaapNamespace: taxonomy.gaapNamespace, gcdNamespace: taxonomy.gcdNamespace, entryPoint: taxonomy.entryPoint, gcdEntryPoint: taxonomy.gcdEntryPoint, generationDate: '2027-01-10',
    }, createFinancialStatements(balances))
    const archive = await readFile(path.join(process.cwd(), 'public', 'taxonomies', 'german-gaap-taxonomy-v6.9-2025-04-01-xbrl.zip'))
    expect(() => validateEBalanceConcepts(xml, archive)).not.toThrow()
  })
})
