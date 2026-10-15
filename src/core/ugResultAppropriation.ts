/** Commercial result appropriation, not a tax-loss assessment. GmbHG §§ 5a(3), 29. */
export interface UgResultAppropriation {
  priorLossCarryforwardCents: number
  priorProfitCarryforwardCents: number
  reserveAllocationCents: number
  distributionCents: number
  carryforwardCents: number
  priorCarryforwardEvidenceId: string
  resolutionEvidenceId: string
  capitalAccountId: string
  carryforwardAccountId: string
  reserveAccountId: string
  priorStatutoryReserveCents: number
  reserveProposalId: string
}

export function calculateUgResultAppropriation(resultCents: number, priorLossCents: number, priorProfitCents: number, distributionCents = 0) {
  if (![resultCents, priorLossCents, priorProfitCents, distributionCents].every(Number.isSafeInteger) || [priorLossCents, priorProfitCents, distributionCents].some(value => value < 0) || priorLossCents > 0 && priorProfitCents > 0) throw new TypeError('Commercial result and carryforwards must be exact cents; profit and loss carryforward cannot coexist.')
  const base = BigInt(resultCents) - BigInt(priorLossCents)
  // Product rounding convention: round a fractional cent upwards so the allocation
  // never falls below one quarter. The statute does not specify cent rounding.
  const reserve = base > BigInt(0) ? (base + BigInt(3)) / BigInt(4) : BigInt(0)
  const available = base + BigInt(priorProfitCents) - reserve
  if (BigInt(distributionCents) > (available > BigInt(0) ? available : BigInt(0))) throw new TypeError('Distribution exceeds the result available after loss carryforward and statutory reserve.')
  const carry = available - BigInt(distributionCents)
  if (carry > BigInt(Number.MAX_SAFE_INTEGER) || carry < BigInt(Number.MIN_SAFE_INTEGER)) throw new TypeError('Result appropriation exceeds safe-integer cents.')
  return { reserveAllocationCents: Number(reserve), carryforwardCents: Number(carry) }
}

export function validateUgResultAppropriation(resultCents: number, value: UgResultAppropriation) {
  if (!value || !value.priorCarryforwardEvidenceId?.trim() || !value.resolutionEvidenceId?.trim()) throw new TypeError('UG result appropriation requires prior carryforward and resolution evidence.')
  const expected = calculateUgResultAppropriation(resultCents, value.priorLossCarryforwardCents, value.priorProfitCarryforwardCents, value.distributionCents)
  if (![value.capitalAccountId, value.carryforwardAccountId, value.reserveAccountId].every(id => typeof id === 'string' && id.trim()) || new Set([value.capitalAccountId, value.carryforwardAccountId, value.reserveAccountId]).size !== 3 || !Number.isSafeInteger(value.priorStatutoryReserveCents) || value.priorStatutoryReserveCents < 0) throw new TypeError('Distinct capital, carryforward and statutory reserve accounts and an exact prior reserve are required.')
  if (expected.reserveAllocationCents > 0 && !value.reserveProposalId?.trim()) throw new TypeError('A statutory reserve allocation requires a reviewed posting proposal.')
  if (value.reserveAllocationCents !== expected.reserveAllocationCents || value.carryforwardCents !== expected.carryforwardCents) throw new TypeError('UG statutory reserve and result carryforward must match the exact-cent calculation.')
  // Distribution and reserve releases need additional capital-maintenance controls.
  if (value.distributionCents !== 0) throw new TypeError('Distributions are outside the supported UG close; retain the result or use specialist review.')
  return expected
}

export function reconcileUgEquity(input: { resultCents: number; shareCapitalCents: number; appropriation: UgResultAppropriation; ledgerResultCents: number; priorResultCents: number; currentCreditBalances: ReadonlyMap<string, number>; priorCreditBalances: ReadonlyMap<string, number> }) {
  const { appropriation: value, currentCreditBalances: current, priorCreditBalances: prior } = input
  validateUgResultAppropriation(input.resultCents, value)
  const carry = value.priorProfitCarryforwardCents - value.priorLossCarryforwardCents
  const matches = input.resultCents === input.ledgerResultCents
    && current.get(value.capitalAccountId) === input.shareCapitalCents
    && (prior.get(value.capitalAccountId) ?? 0) === input.shareCapitalCents
    && (prior.get(value.carryforwardAccountId) ?? 0) + input.priorResultCents === carry
    && (prior.get(value.reserveAccountId) ?? 0) === value.priorStatutoryReserveCents
    && (current.get(value.reserveAccountId) ?? 0) === value.priorStatutoryReserveCents + value.reserveAllocationCents
    && (current.get(value.carryforwardAccountId) ?? 0) === carry - value.reserveAllocationCents
  if (!matches) throw new TypeError('UG capital, commercial carryforward, result and statutory reserve must reconcile exactly to the current and comparative ledger.')
}
