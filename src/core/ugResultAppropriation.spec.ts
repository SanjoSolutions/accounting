import { describe, expect, test } from 'vitest'
import { calculateUgResultAppropriation, reconcileUgEquity, validateUgResultAppropriation, type UgResultAppropriation } from './ugResultAppropriation'
import { validateHgbWorkpaper, type HgbWorkpaperDraft } from './hgbWorkpapers'

const appropriation: UgResultAppropriation = { priorLossCarryforwardCents: 10_000, priorProfitCarryforwardCents: 0, reserveAllocationCents: 475, distributionCents: 0, carryforwardCents: 1425, priorCarryforwardEvidenceId: 'prior-close', resolutionEvidenceId: 'resolution', capitalAccountId: 'capital', carryforwardAccountId: 'carry', reserveAccountId: 'reserve', priorStatutoryReserveCents: 0, reserveProposalId: 'reserve-2026' }

describe('evidence-backed commercial UG result appropriation', () => {
  test.each([
    [11_900, 10_000, 0, 475, 1425],
    [11_900, 20_000, 0, 0, -8100],
    [10_000, 10_000, 0, 0, 0],
    [-1234, 100, 0, 0, -1334],
    [10_003, 0, 0, 2501, 7502],
    [1, 0, 0, 1, 0],
    [100, 0, 500, 25, 575],
    [-100, 0, 500, 0, 400],
  ])('Given result %i, loss %i and profit carryforward %i cents, when allocated, then reserve is %i and carryforward %i cents', (result, loss, profit, reserve, carry) => {
    expect(calculateUgResultAppropriation(result, loss, profit)).toEqual({ reserveAllocationCents: reserve, carryforwardCents: carry })
  })

  test('Given fractional, simultaneous carryforwards or excessive distribution, when calculated, then invalid facts fail closed', () => {
    expect(() => calculateUgResultAppropriation(1.5, 0, 0)).toThrow(/exact cents/)
    expect(() => calculateUgResultAppropriation(100, 1, 1)).toThrow(/cannot coexist/)
    expect(() => calculateUgResultAppropriation(100, 0, 0, 76)).toThrow(/exceeds/)
    expect(() => calculateUgResultAppropriation(Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, 0)).toThrow(/safe-integer/)
    expect(() => validateUgResultAppropriation(11900, { ...appropriation, resolutionEvidenceId: '' })).toThrow(/evidence/)
    expect(() => validateUgResultAppropriation(11900, { ...appropriation, reserveAllocationCents: 474 })).toThrow(/exact-cent/)
    expect(() => validateUgResultAppropriation(11900, { ...appropriation, distributionCents: 1, carryforwardCents: 1424 })).toThrow(/outside/)
  })

  test('Given a UG reserve, when prepared, then the exact evidence, amount and equity accounts are required in its proposal', () => {
    const draft: HgbWorkpaperDraft = { kind: 'GMBH_EQUITY_AND_RESULT', title: 'UG 2026', conclusion: 'COMPLETE', evidenceIds: ['equity'], schedule: { type: 'GMBH_EQUITY_RESULT', applicability: 'APPLICABLE', rationale: 'Synthetic 2025 loss of EUR 100 offsets 2026 profit of EUR 119.', shareCapitalCents: 100000, resultCents: 11900, equityReconciled: true, section5aReserveApplicable: true, evidenceId: 'equity', reserveCalculationEvidenceId: 'calculation', proposalIds: ['reserve-2026'], resultAppropriation: appropriation }, adjustments: [{ id: 'reserve-2026', bookingDate: '2026-12-31', description: '§5a reserve', evidenceIds: ['calculation'], lines: [{ accountId: 'carry', debitCents: 475, creditCents: 0 }, { accountId: 'reserve', debitCents: 0, creditCents: 475 }] }] }
    expect(validateHgbWorkpaper(draft, { startsAt: '2026-01-01', endsAt: '2026-12-31' }).adjustments).toHaveLength(1)
    const changed = structuredClone(draft); changed.adjustments[0].lines[0].debitCents = 474; changed.adjustments[0].lines[1].creditCents = 474
    expect(() => validateHgbWorkpaper(changed, { startsAt: '2026-01-01', endsAt: '2026-12-31' })).toThrow(/deterministic amount/)
  })

  test('Given declared equity reconciled, when actual balances disagree by one cent, then a declaration cannot replace the ledger proof', () => {
    const input = { resultCents: 11900, shareCapitalCents: 100000, appropriation, ledgerResultCents: 11900, priorResultCents: 0, currentCreditBalances: new Map([['capital', 100000], ['carry', -10475], ['reserve', 475]]), priorCreditBalances: new Map([['capital', 100000], ['carry', -10000]]) }
    expect(() => reconcileUgEquity(input)).not.toThrow()
    expect(() => reconcileUgEquity({ ...input, ledgerResultCents: 11901 })).toThrow(/reconcile exactly/)
    expect(() => reconcileUgEquity({ ...input, currentCreditBalances: new Map([...input.currentCreditBalances, ['reserve', 474]]) })).toThrow(/reconcile exactly/)
    expect(() => reconcileUgEquity({ ...input, priorCreditBalances: new Map([...input.priorCreditBalances, ['carry', -9999]]) })).toThrow(/reconcile exactly/)
  })
})
