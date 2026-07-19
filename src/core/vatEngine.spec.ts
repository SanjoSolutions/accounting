import { describe, expect, it } from 'vitest'
import { VatRuleBook, attachVatDocument, calculateMixedVat, calculateVat, createConfiguredVatIdValidator, createConfiguredVatReversalStore, createConfiguredVatTransportEvidenceVerifier, createTestVatIdValidationEvidence, createTestVatReversalStore, createTestVatRuleBook, createTestVatTransportEvidence, reconcileVat, representativeGermanVatRules, requireVatReconciliation, restoreVatIdValidationEvidenceWithAuthority, restoreVatPosting, restoreVatTransportEvidenceWithAuthority, validateVatIdWithAuthority, verifyVatTransportEvidenceWithAuthority, type VatReversalPersistence, type VatRule } from './vatEngine'

const book = createTestVatRuleBook(representativeGermanVatRules)
const ownerId = 'company-1'
const split = (ruleId: string, amountCents = 10_000, mode: 'net' | 'gross' = 'net') => ({ ownerId, sourceId: `${ruleId}-${amountCents}-${mode}`, amountCents, mode, taxPoint: '2026-07-17', ruleId })

describe('effective-dated VAT engine', () => {
  it('selects the historic effective rule and rejects gaps and overlapping versions', () => {
    const versions: VatRule[] = [
      { ...representativeGermanVatRules[0], id: 'RATE', version: 1, validFrom: '2020-01-01', validTo: '2024-12-31', rateBasisPoints: 1600 },
      { ...representativeGermanVatRules[0], id: 'RATE', version: 2, validFrom: '2025-01-01', rateBasisPoints: 1900 },
    ]
    const rules = createTestVatRuleBook(versions)
    expect(rules.at('RATE', '2024-06-01').version).toBe(1)
    expect(rules.at('RATE', '2026-01-01').version).toBe(2)
    expect(() => rules.at('RATE', '2019-01-01')).toThrow(/No VAT rule/)
    expect(() => new VatRuleBook([{ ...versions[0], validTo: '2025-01-01' }, versions[1]])).toThrow(/Overlapping/)
    expect(() => new VatRuleBook([{ ...versions[0], case: 'typo' as never }])).toThrow(/Unsupported VAT case discriminant/)
    expect(() => new VatRuleBook([{ ...versions[0], returnBoxes: [{ box: '81', value: 'typo' as never }] }])).toThrow(/Unsupported VAT return-box mapping discriminant/)
    expect(() => new VatRuleBook([{ ...versions[0], returnBoxes: [{ box: '81', value: 'output-tax', direction: 'sideways' as never }] }])).toThrow(/Unsupported VAT return-box mapping discriminant/)
    expect(() => new VatRuleBook([{ ...versions[0], returnBoxes: [{ box: '81', value: 'output-tax' }, { box: '81', value: 'output-tax' }] }])).toThrow(/Duplicate VAT return-box mapping/)
  })

  it('preserves net/gross source values and applies legal half-up cent rounding', () => {
    expect(calculateVat(split('DE_STANDARD'), book)).toMatchObject({ amountCents: 10_000, netBaseCents: 10_000, taxCents: 1_900, grossCents: 11_900, rateBasisPoints: 1900 })
    expect(calculateVat(split('DE_STANDARD', 11_900, 'gross'), book)).toMatchObject({ amountCents: 11_900, netBaseCents: 10_000, taxCents: 1_900 })
    expect(calculateVat(split('DE_STANDARD', 1), book).taxCents).toBe(0)
    expect(calculateVat(split('DE_STANDARD', 3), book).taxCents).toBe(1)
    expect(calculateVat(split('DE_STANDARD', 3, 'gross'), book)).toMatchObject({ netBaseCents: 3, taxCents: 0, grossCents: 3 })
    expect(calculateVat({ ...split('DE_13B', 10_000, 'gross'), direction: 'purchase' }, book)).toMatchObject({ netBaseCents: 10_000, grossCents: 10_000 })
    const callerWithAttachmentMetadata = calculateVat({ ...split('DE_STANDARD'), documentId: 'unverified-document' } as never, book)
    expect(callerWithAttachmentMetadata).not.toHaveProperty('documentId')
    const twentyPercent = new VatRuleBook([{ ...representativeGermanVatRules[0], id: 'TWENTY_PERCENT', rateBasisPoints: 2_000 }])
    expect(calculateVat({ ...split('TWENTY_PERCENT', 3, 'gross'), direction: 'purchase' }, twentyPercent)).toMatchObject({ netBaseCents: 2, taxCents: 1, inputTaxCents: 1, grossCents: 3 })
  })

  it('calculates mixed rates without losing source splits and reverses credits exactly', () => {
    const reversalRegistry = createTestVatReversalStore(ownerId)
    const details = calculateMixedVat([split('DE_STANDARD'), split('DE_REDUCED', 5_000)], book)
    expect(details.map(item => item.taxCents)).toEqual([1_900, 350])
    expect(details.map(item => item.sourceId)).toEqual(['DE_STANDARD-10000-net', 'DE_REDUCED-5000-net'])
    const original = calculateVat({ ...split('DE_STANDARD'), sourceId: 'invoice' }, book, undefined, reversalRegistry)
    const restartRegistry = createTestVatReversalStore(ownerId); const beforeRestart = calculateVat({ ...split('DE_STANDARD'), sourceId: 'restart-original' }, book, undefined, restartRegistry); const afterRestart = restoreVatPosting(structuredClone(beforeRestart), book, restartRegistry)
    const reorderedPosting = { ...structuredClone(beforeRestart), returnBoxes: beforeRestart.returnBoxes.map(box => ({ ...(box.direction ? { direction: box.direction } : {}), value: box.value, box: box.box })) }
    expect(restoreVatPosting(reorderedPosting, book, restartRegistry)).toMatchObject({ sourceId: 'restart-original', taxCents: 1_900 })
    expect(() => restoreVatPosting({ ...structuredClone(beforeRestart), documentId: 'forged-document' } as never, book, restartRegistry)).toThrow(/unexpected fields.*separate verified attachment boundary/)
    expect(reconcileVat([afterRestart], { outputTaxCents: 1_900, inputTaxCents: 0 }).ok).toBe(true)
    const beforeRestartCredit = calculateVat({ ...split('DE_STANDARD'), sourceId: 'restart-credit', reversalOf: beforeRestart.sourceId, originalTaxPoint: beforeRestart.taxPoint }, book, afterRestart, restartRegistry)
    expect(beforeRestartCredit.taxCents).toBe(-1_900)
    expect(restoreVatPosting(structuredClone(beforeRestartCredit), book, restartRegistry, afterRestart)).toMatchObject({ amountCents: -10_000, taxCents: -1_900 })
    expect(() => restoreVatPosting({ ...structuredClone(beforeRestart), taxCents: 1_899 }, book, restartRegistry)).toThrow(/canonical calculated durable binding/)
    const untrustedRegistry = createTestVatReversalStore(ownerId); const untrustedRules = new VatRuleBook(representativeGermanVatRules); const untrustedOriginal = calculateVat({ ...split('DE_STANDARD'), sourceId: 'untrusted-original' }, book, undefined, untrustedRegistry)
    expect(() => calculateVat({ ...split('DE_STANDARD'), sourceId: 'untrusted-credit', reversalOf: 'untrusted-original', originalTaxPoint: untrustedOriginal.taxPoint }, untrustedRules, untrustedOriginal, untrustedRegistry)).toThrow(/trusted authoritative rule book/)
    expect(calculateVat({ ...split('DE_STANDARD'), sourceId: 'trusted-retry', reversalOf: 'untrusted-original', originalTaxPoint: untrustedOriginal.taxPoint }, book, untrustedOriginal, untrustedRegistry).taxCents).toBe(-1_900)
    expect(calculateVat({ ...split('DE_STANDARD'), sourceId: 'credit', reversalOf: 'invoice', originalTaxPoint: original.taxPoint }, book, original, reversalRegistry)).toMatchObject({ netBaseCents: -10_000, taxCents: -1_900, outputTaxCents: -1_900 })
    const secondOriginal = calculateVat({ ...split('DE_STANDARD'), sourceId: 'second-invoice' }, book, undefined, reversalRegistry)
    expect(() => calculateVat({ ...split('DE_STANDARD'), sourceId: 'credit', reversalOf: secondOriginal.sourceId, originalTaxPoint: secondOriginal.taxPoint }, book, secondOriginal, reversalRegistry)).toThrow(/different immutable canonical VAT original/)
    expect(calculateVat({ ...split('DE_STANDARD'), sourceId: 'second-credit', reversalOf: secondOriginal.sourceId, originalTaxPoint: secondOriginal.taxPoint }, book, secondOriginal, reversalRegistry).taxCents).toBe(-1_900)
    expect(() => calculateVat({ ...split('DE_STANDARD'), sourceId: 'untrusted', reversalOf: 'invoice' }, book, undefined, reversalRegistry)).toThrow(/exact immutable original/)
    expect(() => calculateVat({ ...split('DE_STANDARD'), sourceId: 'forged', reversalOf: 'invoice', originalTaxPoint: original.taxPoint }, book, { ...original }, reversalRegistry)).toThrow(/exact immutable original/)
    const mismatchOriginal = calculateVat({ ...split('DE_STANDARD'), sourceId: 'invoice-mismatch' }, book, undefined, reversalRegistry)
    expect(() => calculateVat({ ...split('DE_STANDARD', 9_999), sourceId: 'mismatch', reversalOf: 'invoice-mismatch', originalTaxPoint: mismatchOriginal.taxPoint }, book, mismatchOriginal, reversalRegistry)).toThrow(/exactly match/)
    const identityOriginal = calculateVat({ ...split('DE_STANDARD'), sourceId: 'invoice-identity' }, book, undefined, reversalRegistry)
    expect(() => calculateVat({ ...split('DE_STANDARD'), sourceId: 'identity-mismatch', reversalOf: 'invoice-identity', originalTaxPoint: identityOriginal.taxPoint, customerCountry: 'FR' }, book, identityOriginal, reversalRegistry)).toThrow(/exactly match/)
    expect(() => calculateVat({ ...split('DE_STANDARD'), sourceId: 'credit-again', reversalOf: 'invoice', originalTaxPoint: original.taxPoint }, book, original, reversalRegistry)).toThrow(/reversal conflicts with durable persistence/)
    const sourceBoundRegistry = createTestVatReversalStore(ownerId); const sourceBoundOriginal = calculateVat({ ...split('DE_STANDARD'), sourceId: 'stable-source' }, book, undefined, sourceBoundRegistry)
    expect(() => calculateVat({ ...split('DE_STANDARD'), sourceId: 'stable-source', customerCountry: 'FR' }, book, undefined, sourceBoundRegistry)).toThrow(/different immutable canonical VAT original/)
    calculateVat({ ...split('DE_STANDARD'), sourceId: 'stable-credit', reversalOf: 'stable-source', originalTaxPoint: sourceBoundOriginal.taxPoint }, book, sourceBoundOriginal, sourceBoundRegistry)
    const alteredSourceOriginal = calculateVat({ ...split('DE_STANDARD', 20_000), sourceId: 'stable-source' }, book)
    expect(() => calculateVat({ ...split('DE_STANDARD', 20_000), sourceId: 'altered-credit', reversalOf: 'stable-source', originalTaxPoint: alteredSourceOriginal.taxPoint }, book, alteredSourceOriginal, sourceBoundRegistry)).toThrow(/canonical owner\/source-bound original/)
    const batchOriginal = calculateVat({ ...split('DE_STANDARD'), sourceId: 'batch-original' }, book, undefined, reversalRegistry)
    expect(() => calculateMixedVat([{ ...split('DE_STANDARD'), sourceId: 'batch-credit-1', reversalOf: 'batch-original', originalTaxPoint: batchOriginal.taxPoint }, { ...split('DE_STANDARD'), sourceId: 'batch-credit-2', reversalOf: 'batch-original', originalTaxPoint: batchOriginal.taxPoint }], book, [batchOriginal], reversalRegistry)).toThrow(/only once/)
    const registry = createTestVatReversalStore(ownerId); const atomicOne = calculateVat({ ...split('DE_STANDARD'), sourceId: 'atomic-one' }, book, undefined, registry); const atomicTwo = calculateVat({ ...split('DE_STANDARD'), sourceId: 'atomic-two' }, book, undefined, registry)
    expect(() => calculateMixedVat([{ ...split('DE_STANDARD'), sourceId: 'atomic-credit', reversalOf: 'atomic-one', originalTaxPoint: atomicOne.taxPoint }, { ...split('DE_STANDARD', 9_999), sourceId: 'atomic-fail', reversalOf: 'atomic-two', originalTaxPoint: atomicTwo.taxPoint }], book, [atomicOne, atomicTwo], registry)).toThrow(/exactly match/)
    expect(calculateVat({ ...split('DE_STANDARD'), sourceId: 'atomic-retry', reversalOf: 'atomic-one', originalTaxPoint: atomicOne.taxPoint }, book, atomicOne, registry).taxCents).toBe(-1_900)
    const restored = createTestVatReversalStore(ownerId, registry.snapshot())
    expect(() => calculateVat({ ...split('DE_STANDARD'), sourceId: 'atomic-after-restart', reversalOf: 'atomic-one', originalTaxPoint: atomicOne.taxPoint }, book, atomicOne, restored)).toThrow(/reversal conflicts with durable persistence/)
    const partialRegistry = createTestVatReversalStore(ownerId)
    expect(() => calculateMixedVat([{ ...split('DE_STANDARD'), sourceId: 'partial-source' }, { ...split('DE_STANDARD'), sourceId: 'partial-failure', amountCents: Number.NaN }], book, [], partialRegistry)).toThrow(/non-negative safe-integer cents/)
    expect(calculateVat({ ...split('DE_STANDARD', 20_000), sourceId: 'partial-source' }, book, undefined, partialRegistry).amountCents).toBe(20_000)
  })

  it('posts later-period credits on their own tax date while retaining the original rule and rate', () => {
    const versions: VatRule[] = [
      { ...representativeGermanVatRules[0], id: 'RATE_CHANGE', version: 1, validFrom: '2026-01-01', validTo: '2026-12-31', rateBasisPoints: 1900 },
      { ...representativeGermanVatRules[0], id: 'RATE_CHANGE', version: 2, validFrom: '2027-01-01', rateBasisPoints: 2000 },
    ]
    const rules = createTestVatRuleBook(versions)
    const originalRegistry = createTestVatReversalStore(ownerId)
    const original = calculateVat({ ownerId, sourceId: 'rate-original', amountCents: 10_000, mode: 'net', taxPoint: '2026-12-20', ruleId: 'RATE_CHANGE' }, rules, undefined, originalRegistry)
    expect(() => calculateVat({ ownerId, sourceId: 'no-registry-credit', amountCents: 10_000, mode: 'net', taxPoint: '2027-01-10', ruleId: 'RATE_CHANGE', reversalOf: original.sourceId, originalTaxPoint: original.taxPoint }, rules, original)).toThrow(/configured durable transactional store/)
    expect(() => calculateVat({ ownerId, sourceId: 'wrong-owner-credit', amountCents: 10_000, mode: 'net', taxPoint: '2027-01-10', ruleId: 'RATE_CHANGE', reversalOf: original.sourceId, originalTaxPoint: original.taxPoint }, rules, original, createTestVatReversalStore('company-2:vat-ledger'))).toThrow(/same canonical owner scope/)
    expect(() => calculateVat({ ownerId: 'company-2', sourceId: 'cross-owner-credit', amountCents: 10_000, mode: 'net', taxPoint: '2027-01-10', ruleId: 'RATE_CHANGE', reversalOf: original.sourceId, originalTaxPoint: original.taxPoint }, rules, original, createTestVatReversalStore('company-2'))).toThrow(/exactly match/)
    const credit = calculateVat({ ownerId, sourceId: 'rate-credit', amountCents: 10_000, mode: 'net', taxPoint: '2027-01-10', ruleId: 'RATE_CHANGE', reversalOf: original.sourceId, originalTaxPoint: original.taxPoint }, rules, original, originalRegistry)
    expect(credit).toMatchObject({ taxPoint: '2027-01-10', originalTaxPoint: '2026-12-20', ruleVersion: 1, rateBasisPoints: 1900, taxCents: -1_900 })
    expect(() => calculateVat({ ownerId, sourceId: 'missing-origin-date', amountCents: 10_000, mode: 'net', taxPoint: '2027-01-10', ruleId: 'RATE_CHANGE', reversalOf: original.sourceId }, rules, original, createTestVatReversalStore(ownerId))).toThrow(/original tax point/)
  })

  it('binds configured reversal history to one persistent owner store and rejects reset adapters', () => {
    const consumed = new Set<string>(); const persistence: VatReversalPersistence = { appendAllUnique: (_owner, identities) => { if (identities.some(identity => consumed.has(identity))) return false; identities.forEach(identity => consumed.add(identity)); return true }, snapshot: () => [...consumed] }
    const first = createConfiguredVatReversalStore('configured-owner', persistence); const configuredOriginal = calculateVat({ ...split('DE_STANDARD'), ownerId: 'configured-owner', sourceId: 'source-1' }, book, undefined, first); calculateVat({ ...split('DE_STANDARD'), ownerId: 'configured-owner', sourceId: 'source-1-credit', reversalOf: 'source-1', originalTaxPoint: configuredOriginal.taxPoint }, book, configuredOriginal, first)
    const resumed = createConfiguredVatReversalStore('configured-owner', persistence)
    expect(() => calculateVat({ ...split('DE_STANDARD'), ownerId: 'configured-owner', sourceId: 'source-1-credit-again', reversalOf: 'source-1', originalTaxPoint: configuredOriginal.taxPoint }, book, configuredOriginal, resumed)).toThrow(/reversal conflicts with durable persistence/)
    expect(() => createConfiguredVatReversalStore('configured-owner', { appendAllUnique: () => true, snapshot: () => [] })).toThrow(/cannot be reset/)
    const atomicConsumed = new Set<string>(); const staleSnapshotPersistence: VatReversalPersistence = { appendAllUnique: (_owner, identities) => { if (identities.some(identity => atomicConsumed.has(identity))) return false; identities.forEach(identity => atomicConsumed.add(identity)); return true }, snapshot: () => [] }
    const racingOne = createConfiguredVatReversalStore('racing-owner', staleSnapshotPersistence); const racingTwo = createConfiguredVatReversalStore('racing-owner', staleSnapshotPersistence)
    calculateVat({ ...split('DE_STANDARD'), ownerId: 'racing-owner', sourceId: 'shared-source' }, book, undefined, racingOne)
    expect(() => calculateVat({ ...split('DE_STANDARD', 20_000), ownerId: 'racing-owner', sourceId: 'shared-source' }, book, undefined, racingTwo)).toThrow(/conflicts with durable persistence/)
  })

  it('covers zero/exempt, §13b, intra-EU, import, deposits/final invoices and private use', () => {
    expect(calculateVat(split('DE_ZERO'), book).taxCents).toBe(0)
    expect(calculateVat(split('DE_EXEMPT'), book).deductibleTaxCents).toBe(0)
    expect(calculateVat({ ...split('DE_13B'), direction: 'purchase' }, book)).toMatchObject({ taxCents: 1_900, grossCents: 10_000, outputTaxCents: 1_900, inputTaxCents: 1_900 })
    expect(calculateVat({ ...split('EU_ACQUISITION'), direction: 'purchase' }, book)).toMatchObject({ outputTaxCents: 1_900, inputTaxCents: 1_900 })
    expect(calculateVat({ ...split('IMPORT_VAT'), direction: 'purchase' }, book)).toMatchObject({ outputTaxCents: 0, inputTaxCents: 1_900 })
    expect(calculateVat({ ...split('DE_13B_SUPPLIER'), direction: 'sale' }, book)).toMatchObject({ taxCents: 0, outputTaxCents: 0, inputTaxCents: 0, returnBoxes: [{ box: '60' }] })
    expect(() => calculateVat(split('DE_13B'), book)).toThrow(/requires a purchase direction/)
    expect(() => calculateVat({ ...split('DE_13B_SUPPLIER'), direction: 'purchase' }, book)).toThrow(/requires a sale direction/)
    expect(calculateVat(split('DE_DEPOSIT'), book).case).toBe('deposit')
    expect(calculateVat(split('DE_FINAL'), book).case).toBe('final-invoice')
    expect(calculateVat(split('DE_PRIVATE_USE'), book)).toMatchObject({ case: 'private-use', outputTaxCents: 1_900, inputTaxCents: 0 })
    expect(() => calculateVat({ ...split('DE_PRIVATE_USE'), direction: 'purchase' }, book)).toThrow(/deemed supplies require a sale direction/)
    expect(() => calculateVat({ ...split('DE_STANDARD'), amountCents: -100 }, book)).toThrow(/reversalOf/)
    expect(() => calculateVat({ ...split('DE_STANDARD'), mode: 'mystery' as never }, book)).toThrow(/mode and direction.*canonical discriminants/)
    expect(() => calculateVat({ ...split('DE_STANDARD'), direction: 'sideways' as never }, book)).toThrow(/mode and direction.*canonical discriminants/)
    expect(calculateVat({ ...split('DE_ZERO'), direction: 'purchase' }, book).returnBoxes).toEqual([])
    expect(calculateVat({ ...split('DE_EXEMPT'), direction: 'purchase' }, book).returnBoxes).toEqual([])
    expect(calculateVat({ ...split('DE_DEPOSIT'), direction: 'purchase' }, book).returnBoxes).toEqual([{ box: '66', value: 'input-tax', direction: 'purchase' }])
    expect(calculateVat({ ...split('DE_FINAL'), direction: 'purchase' }, book).returnBoxes).toEqual([{ box: '66', value: 'input-tax', direction: 'purchase' }])
  })

  it('reconciles invoice detail to control accounts and every return box with document drilldown', () => {
    const details = [
      attachVatDocument(calculateVat(split('DE_STANDARD'), book), 'doc-1'),
      attachVatDocument(calculateVat({ ...split('DE_13B'), sourceId: 'entry-2', direction: 'purchase' }, book), 'doc-2'),
    ]
    const result = reconcileVat(details, { outputTaxCents: 3_800, inputTaxCents: 1_900 })
    expect(result.ok).toBe(true)
    expect(result.boxes.find(box => box.box === '81')?.amountCents).toBe(10_000)
    expect(result.boxes.find(box => box.box === '67')).toMatchObject({ amountCents: 1_900, entryIds: ['entry-2'], documentIds: ['doc-2'] })
    expect(result.boxes.find(box => box.box === '85')?.amountCents).toBe(1_900)
    const broken = reconcileVat(details, { outputTaxCents: 0, inputTaxCents: 0 })
    expect(broken.discrepancies).toHaveLength(2)
    expect(() => requireVatReconciliation(broken)).toThrow(/control differs/)
    const otherOwner = calculateVat({ ...split('DE_STANDARD'), ownerId: 'company-2', sourceId: 'other-owner' }, book)
    expect(() => reconcileVat([details[0], otherOwner], { outputTaxCents: 3_800, inputTaxCents: 0 })).toThrow(/one canonical owner/)
  })

  it('rejects impossible rule rates and real-date gaps', () => {
    expect(() => new VatRuleBook([{ ...representativeGermanVatRules[0], id: 'BAD', rateBasisPoints: Number.NaN }])).toThrow(/Invalid VAT rate/)
    expect(() => new VatRuleBook([{ ...representativeGermanVatRules[0], id: 'BAD', validFrom: '2026-02-30' }])).toThrow(/Invalid effective dates/)
    expect(() => new VatRuleBook([{ ...representativeGermanVatRules[0], version: Number.NaN }])).toThrow(/positive audit version/)
    expect(() => createTestVatRuleBook([{ ...representativeGermanVatRules[0], id: '   ' }])).toThrow(/canonical nonblank/)
    expect(() => createTestVatRuleBook([{ ...representativeGermanVatRules[0], reason: '   ' }])).toThrow(/audit-reason provenance/)
    expect(() => new VatRuleBook([{ ...representativeGermanVatRules[0] }, { ...representativeGermanVatRules[0], validFrom: '1900-01-01', validTo: '2006-12-31' }])).toThrow(/duplicate positive audit version/)
    expect(() => calculateVat({ ...split('DE_STANDARD'), sourceId: '   ' }, book, undefined, createTestVatReversalStore(ownerId))).toThrow(/nonblank canonical source ID/)
    expect(() => book.at('DE_STANDARD', '2026-02-30')).toThrow(/Invalid tax point/)
    const untrustedPosting = calculateVat(split('DE_STANDARD'), new VatRuleBook(representativeGermanVatRules))
    expect(() => reconcileVat([untrustedPosting], { outputTaxCents: 1_900, inputTaxCents: 0 })).toThrow(/exact trusted calculated/)
  })

  it('requires qualified outbound B2B evidence for zero-rated EU supplies', () => {
    const evidence = createTestVatTransportEvidence({ ownerId, type: 'carrier-document', reference: 'CMR-1', dispatchedFromCountry: 'DE', destinationCountry: 'FR', sourceId: 'eu-sale' })
    const validation = createTestVatIdValidationEvidence('FR12345678901', 'FR')
    const eligible = { ownerId, sourceId: 'eu-sale', amountCents: 100, mode: 'net' as const, taxPoint: '2026-01-01', ruleId: 'EU_SUPPLY', direction: 'sale' as const, customerType: 'business' as const, customerCountry: 'FR', customerVatId: 'FR12345678901', customerVatIdValidation: validation, supplyKind: 'goods' as const, transportEvidence: evidence }
    expect(calculateVat(eligible, book).taxCents).toBe(0)
    expect(() => calculateVat({ ...eligible, customerVatIdValidation: createTestVatIdValidationEvidence('FR12345678901', 'FR', '2026-01-02T00:00:00.000Z') }, book)).toThrow(/effective at the tax point/)
    expect(() => calculateVat({ ...eligible, taxPoint: '2026-04-02' }, book)).toThrow(/effective at the tax point/)
    expect(calculateVat({ ...eligible, taxPoint: '2026-04-01' }, book).taxCents).toBe(0)
    expect(() => calculateVat({ ...eligible, customerVatIdValidation: { ...validation } }, book)).toThrow(/authoritative validation evidence/)
    expect(() => calculateVat({ ...eligible, customerVatId: 'FRABCDEFGHIJK' }, book)).toThrow(/country-specific VAT-ID syntax/)
    expect(calculateVat({ ...eligible, customerCountry: 'GR', customerVatId: 'EL123456789', customerVatIdValidation: createTestVatIdValidationEvidence('EL123456789', 'GR'), transportEvidence: createTestVatTransportEvidence({ ownerId, type: 'carrier-document', reference: 'CMR-GR', dispatchedFromCountry: 'DE', destinationCountry: 'GR', sourceId: 'eu-sale' }) }, book).taxCents).toBe(0)
    expect(calculateVat({ ...eligible, customerCountry: 'XI', customerVatId: 'XI123456789', customerVatIdValidation: createTestVatIdValidationEvidence('XI123456789', 'XI'), transportEvidence: createTestVatTransportEvidence({ ownerId, type: 'carrier-document', reference: 'CMR-XI', dispatchedFromCountry: 'DE', destinationCountry: 'XI', sourceId: 'eu-sale' }) }, book).taxCents).toBe(0)
    expect(() => calculateVat({ ...eligible, supplyKind: 'services' }, book)).toThrow(/outbound goods/)
    expect(() => calculateVat({ ...eligible, transportEvidence: undefined }, book)).toThrow(/transport evidence/)
    expect(() => calculateVat({ ...eligible, transportEvidence: { ...evidence, dispatchedFromCountry: 'FR' } }, book)).toThrow(/transport evidence/)
    expect(() => calculateVat({ ...eligible, customerCountry: 'US', customerVatId: 'US123456789', transportEvidence: { ...evidence, destinationCountry: 'US' } }, book)).toThrow(/transport evidence/)
    expect(() => calculateVat({ ...eligible, transportEvidence: { ...evidence, type: 'self-asserted' as never } }, book)).toThrow(/transport evidence/)
    expect(() => calculateVat({ ...eligible, transportEvidence: { ...evidence } }, book)).toThrow(/transport evidence/)
    expect(() => calculateVat({ ...eligible, sourceId: 'unrelated-sale' }, book)).toThrow(/source-bound canonical transport evidence/)
    expect(() => calculateVat({ ...eligible, ownerId: 'company-2' }, book)).toThrow(/owner\/source-bound canonical transport evidence/)
    const service = { ownerId, sourceId: 'eu-service', amountCents: 100, mode: 'net' as const, taxPoint: '2026-01-01', ruleId: 'EU_SERVICE', direction: 'sale' as const, customerType: 'business' as const, customerCountry: 'FR', customerVatId: 'FR12345678901', customerVatIdValidation: createTestVatIdValidationEvidence('FR12345678901', 'FR'), supplyKind: 'services' as const }
    expect(calculateVat(service, book)).toMatchObject({ case: 'intra-eu-service', taxCents: 0, returnBoxes: [{ box: '21' }] })
    expect(() => calculateVat({ ...service, customerVatIdValidation: createTestVatIdValidationEvidence('FR12345678901', 'FR', '2026-01-02T00:00:00.000Z') }, book)).toThrow(/effective at the tax point/)
    expect(() => calculateVat({ ...service, supplyKind: 'goods' }, book)).toThrow(/outbound service/)
  })

  it('creates VAT-ID evidence only through the exact configured authoritative validator', async () => {
    const validator = createConfiguredVatIdValidator({ validate: async normalizedVatId => ({ valid: normalizedVatId === 'FR12345678901', validationId: 'vies-1', validatedAt: '2026-01-02T03:04:05.000Z' }) }, 'vies-production')
    const evidence = await validateVatIdWithAuthority('FR 12 345 678 901', 'FR', 'goods', validator)
    await expect(restoreVatIdValidationEvidenceWithAuthority(structuredClone(evidence), 'goods', validator)).resolves.toMatchObject(evidence)
    await expect(validateVatIdWithAuthority('FR12345678901', 'FR', 'goods', { ...validator })).rejects.toThrow(/exact configured authoritative validator/)
    await expect(validateVatIdWithAuthority('FRABCDEFGHIJK', 'FR', 'goods', validator)).rejects.toThrow(/country-specific syntax/)
    const impossibleDate = createConfiguredVatIdValidator({ validate: async () => ({ valid: true, validationId: 'invalid-date', validatedAt: '2026-02-30T00:00:00.000Z' }) }, 'vies-invalid-date')
    await expect(validateVatIdWithAuthority('FR12345678901', 'FR', 'goods', impossibleDate)).rejects.toThrow(/incomplete evidence/)
  })

  it('creates transport evidence only through the exact configured document verifier', async () => {
    const claim = { ownerId, type: 'dispatch-document' as const, reference: 'DESADV-1', dispatchedFromCountry: 'DE', destinationCountry: 'FR', sourceId: 'invoice-1' }
    const verifier = createConfiguredVatTransportEvidenceVerifier({ verify: async () => ({ verified: true, verificationId: 'dms-1', verifiedAt: '2026-01-02T03:04:05.000Z' }) }, 'document-registry-production')
    const evidence = await verifyVatTransportEvidenceWithAuthority(claim, verifier)
    await expect(restoreVatTransportEvidenceWithAuthority(structuredClone(evidence), verifier)).resolves.toMatchObject(evidence)
    await expect(verifyVatTransportEvidenceWithAuthority(claim, { ...verifier })).rejects.toThrow(/exact configured verifier/)
    const impossibleDate = createConfiguredVatTransportEvidenceVerifier({ verify: async () => ({ verified: true, verificationId: 'invalid-date', verifiedAt: '2026-02-30T00:00:00.000Z' }) }, 'document-registry-invalid-date')
    await expect(verifyVatTransportEvidenceWithAuthority(claim, impossibleDate)).rejects.toThrow(/incomplete evidence/)
  })

  it('maps purchases only to input-tax boxes and validates reconciliation controls', () => {
    const purchase = calculateVat({ ...split('DE_STANDARD'), direction: 'purchase' }, book)
    expect(purchase.returnBoxes).toEqual([{ box: '66', value: 'input-tax', direction: 'purchase' }])
    expect(purchase).toMatchObject({ outputTaxCents: 0, inputTaxCents: 1_900 })
    expect(() => reconcileVat([purchase], { outputTaxCents: Number.NaN, inputTaxCents: 1_900 })).toThrow(/finite integer/)
    expect(() => reconcileVat([purchase], { outputTaxCents: 0, inputTaxCents: 1_900 }, -1)).toThrow(/non-negative/)
    expect(() => reconcileVat([purchase, purchase], { outputTaxCents: 0, inputTaxCents: 3_800 })).toThrow(/unique nonblank posting source IDs/)
    expect(() => reconcileVat([{ ...purchase, sourceId: ' ', documentId: ' ' }], { outputTaxCents: 0, inputTaxCents: 1_900 })).toThrow(/nonblank document provenance/)
    expect(() => reconcileVat([{ ...purchase }], { outputTaxCents: 0, inputTaxCents: 1_900 })).toThrow(/exact trusted calculated/)
  })

  it('takes immutable snapshots of rules and reconciliation provenance', () => {
    const mutableRule = { ...representativeGermanVatRules[0], id: 'IMMUTABLE', returnBoxes: [{ box: '81', value: 'net-base' as const }] }
    const immutableBook = new VatRuleBook([mutableRule]); mutableRule.rateBasisPoints = 9999; mutableRule.returnBoxes[0].box = 'spoof'
    expect(immutableBook.at('IMMUTABLE', '2026-01-01')).toMatchObject({ rateBasisPoints: 1900, returnBoxes: [{ box: '81' }] })
    const detail = calculateVat(split('DE_STANDARD'), book); const result = reconcileVat([detail], { outputTaxCents: 1_900, inputTaxCents: 0 })
    expect(Object.isFrozen(result.expected)).toBe(true); expect(Object.isFrozen(result.boxes[0].entryIds)).toBe(true)
  })

  it('enforces OSS destination semantics and preserves reconciliation tolerance', () => {
    const oss = { ownerId, sourceId: 'oss', amountCents: 100, mode: 'net' as const, taxPoint: '2026-01-01', ruleId: 'OSS_FR_STANDARD', direction: 'sale' as const, customerType: 'consumer' as const, customerCountry: 'FR' }
    expect(calculateVat(oss, book).case).toBe('oss-sale')
    expect(() => calculateVat({ ...oss, customerCountry: 'ES' }, book)).toThrow(/matches the rule jurisdiction/)
    expect(reconcileVat([calculateVat(split('DE_STANDARD'), book)], { outputTaxCents: 1_901, inputTaxCents: 0 }, 1)).toMatchObject({ ok: true, toleranceCents: 1 })
    expect(() => reconcileVat([{ ...calculateVat(split('DE_STANDARD'), book), taxCents: Number.NaN }], { outputTaxCents: 1_900, inputTaxCents: 0 })).toThrow(/Every VAT posting monetary field/)
  })

  it('rejects unsafe source calculations and overflowing return-box aggregates', () => {
    expect(() => calculateVat(split('DE_STANDARD', Number.MAX_SAFE_INTEGER), book)).toThrow(/exceed safe integer/)
    const first = calculateVat(split('DE_STANDARD', 4_600_000_000_000_000), book)
    const second = calculateVat({ ...split('DE_STANDARD', 4_600_000_000_000_000), sourceId: 'second' }, book)
    expect(() => reconcileVat([first, second], { outputTaxCents: first.outputTaxCents + second.outputTaxCents, inputTaxCents: 0 })).toThrow(/return box 81 exceeds safe integer/)
  })
})
