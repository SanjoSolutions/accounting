import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFinancialStatements, type LedgerBalance } from '@/core/doubleEntry'
import { createEBalanceXbrl, getEBalanceTaxonomy } from '@/core/eBilanz'
import { validateEBalanceConcepts } from '@/core/eBilanzPackage'
import { profilePayloadWithConfirmedAddress } from './compliance/companyProfile'

vi.mock('server-only', () => ({}))
vi.mock('./persistence/client', () => ({ prisma: {} }))
import { accountSemanticFingerprint, authoritativeEBalanceMasterDataFromSettings, DEFAULT_ACCOUNTS, defaultAccountsForLedger, getEBalanceBlockingIssues, inferExistingLedgerChart, inferExistingLedgerProfile, isStandardPostingPeriod, journalEntryInputForSource, legacyLedgerClaimApplies, manualJournalReference, mergeSubmissionHistory, nextCalendarDay, normalizeDocumentIds, postingDateBoundary, postingOrderPeriodYear, reportingSettingsPayload, requireLegacyLedgerProfile, requireManualDocumentSelection, selectBootstrapChart, selectedChartFromSettingsPayload, selectPostingPeriod, settingsPayloadWithEffectiveProfile, submissionResultStatus, successorOverlapBounds, validateDocumentNamespace, validateLegacyLedgerClaim, validateNumericPeriodBootstrap, validatePostingSuccessorBootstrap, validateSuccessorContiguity, validateSuccessorOverlap } from './ledger'

describe('default ledger taxonomy mappings', () => {
  it('reserves reopened periods for the controlled correction workflow', () => { expect(isStandardPostingPeriod('OPEN')).toBe(true); expect(isStandardPostingPeriod('REOPENED')).toBe(false) })
  it('scales SKR03 defaults to the persisted DATEV account length', () => {
    const numbers = defaultAccountsForLedger('SKR03', 5).map(([number]) => number)
    expect(numbers).toContain(12000)
    expect(numbers).toContain(84000)
    expect(numbers).not.toContain(1200)
    expect(defaultAccountsForLedger('SKR04', 4).length).toBeGreaterThan(0)
  })

  it('supports zero to many unique document attachments', () => {
    expect(normalizeDocumentIds({})).toEqual([])
    expect(normalizeDocumentIds({ documentIds: ['one', 'two', 'one'] })).toEqual(['one', 'two'])
    expect(() => normalizeDocumentIds({ documentIds: [''] })).toThrow('ausgewählten Belege')
  })
  it('requires document selection for manual postings and uses an internal journal reference', () => {
    expect(() => requireManualDocumentSelection('MANUAL', [])).toThrow('mindestens einen Beleg')
    expect(() => requireManualDocumentSelection('MANUAL', ['document-1'])).not.toThrow()
    expect(() => requireManualDocumentSelection('OPENING', [])).not.toThrow()
    expect(manualJournalReference('entry-1')).toBe('JOURNAL-entry-1')
    expect(journalEntryInputForSource('MANUAL', { documentNumber: 'caller-value' }, 'entry-1')).toEqual({ documentNumber: 'JOURNAL-entry-1' })
  })
  it('bootstraps only an empty tenant and rejects uncovered or overlapping posting dates', () => {
    expect(selectPostingPeriod([], 0)).toBeNull()
    expect(() => selectPostingPeriod([], 1)).toThrow('Keine Geschäftsjahresperiode')
    expect(() => selectPostingPeriod([{ id: 'a' }, { id: 'b' }], 2)).toThrow('überlappender')
  })
  it('requires an existing successor to begin exactly after the closing period', () => {
    expect(() => validateSuccessorContiguity(new Date('2026-07-01'), new Date('2026-07-01'))).not.toThrow()
    expect(() => validateSuccessorContiguity(new Date('2026-07-01'), new Date('2026-07-02'))).toThrow('lückenlos')
  })

  it('rejects every other fiscal period overlapping the proposed successor', () => {
    expect(() => validateSuccessorOverlap('expected-successor', ['expected-successor'])).not.toThrow()
    expect(() => validateSuccessorOverlap('expected-successor', ['expected-successor', 'legacy-overlap'])).toThrow(/überschneidet/)
    expect(() => validateSuccessorOverlap(undefined, ['wrong-year-key'])).toThrow(/überschneidet/)
  })
  it('uses a persisted short successor range instead of a synthetic twelve-month overlap window', () => {
    const proposedStart = new Date('2026-01-01T00:00:00.000Z')
    const proposedEnd = new Date('2026-12-31T23:59:59.999Z')
    const shortSuccessor = { startsAt: proposedStart, endsAt: new Date('2026-06-30T23:59:59.999Z') }
    expect(successorOverlapBounds(shortSuccessor, proposedStart, proposedEnd)).toEqual(shortSuccessor)
    expect(successorOverlapBounds(null, proposedStart, proposedEnd)).toEqual({ startsAt: proposedStart, endsAt: proposedEnd })
  })
  it('queries fiscal endpoints by inclusive booking-day boundary', () => {
    expect(postingDateBoundary('2025-12-31')).toEqual(new Date('2025-12-31T00:00:00.000Z'))
    expect(postingDateBoundary('2025-12-31').getTime()).toBeLessThan(new Date('2025-12-31T12:00:00.000Z').getTime())
  })
  it('starts a successor on the next calendar day regardless of stored end time', () => {
    expect(nextCalendarDay(new Date('2025-06-30T00:00:00.000Z'))).toEqual(new Date('2025-07-01T00:00:00.000Z'))
    expect(nextCalendarDay(new Date('2025-06-30T23:59:59.999Z'))).toEqual(new Date('2025-07-01T00:00:00.000Z'))
  })
  it('selects the tenant active chart for bootstrap and honors legacy SKR04 payloads', () => { expect(selectedChartFromSettingsPayload('{"activeChart":"CUSTOM:mine"}')).toBe('CUSTOM:mine'); expect(selectedChartFromSettingsPayload('{"chartOfAccounts":"SKR04"}')).toBe('SKR04'); expect(selectedChartFromSettingsPayload('{}')).toBe('SKR03') })
  it('uses authoritative profile and issuer data for reporting while retaining legacy fallback', () => {
    const supplied = { companyName: 'Transient', street: 'Old', postalCode: '00000', city: 'Old', taxNumber: 'old', legalForm: 'GMBH' as const }
    const profile = { companyName: 'Authoritative KG', legalForm: 'KG', taxNumber: '12/345/67890', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Trade', sizeClass: 'SMALL', chart: 'SKR04', elections: [] }
    expect(authoritativeEBalanceMasterDataFromSettings(JSON.stringify({ companyProfile: profile, invoiceIssuer: { streetAndHouseNumber: 'Main 1', zipCode: '10115', city: 'Berlin' } }), supplied)).toMatchObject({ companyName: 'Authoritative KG', legalForm: 'KG', taxNumber: '12/345/67890', street: 'Main 1', postalCode: '10115', city: 'Berlin' })
    const historical = { ...profile, companyName: 'Historic KG', taxNumber: '98/765/43210' }
    const historicalSettings = settingsPayloadWithEffectiveProfile(JSON.stringify({ companyProfile: profile, invoiceIssuer: { streetAndHouseNumber: 'Current 1', zipCode: '99999', city: 'Current' } }), JSON.stringify(historical))!
    expect(JSON.parse(historicalSettings).companyProfile).toEqual(historical)
    expect(JSON.parse(historicalSettings)).not.toHaveProperty('invoiceIssuer')
    expect(() => authoritativeEBalanceMasterDataFromSettings(historicalSettings, supplied)).toThrow(/vollständig versionierte Anschrift/)
    const versionedAddress = { ...historical, registeredAddress: { streetAndHouseNumber: 'Historic 1', zipCode: '12345', city: 'Oldtown', country: 'DE' } }
    expect(authoritativeEBalanceMasterDataFromSettings(settingsPayloadWithEffectiveProfile(undefined, JSON.stringify(versionedAddress)), supplied)).toMatchObject({ companyName: 'Historic KG', street: 'Historic 1', postalCode: '12345', city: 'Oldtown' })
    expect(() => reportingSettingsPayload(JSON.stringify({ companyProfile: profile }), undefined, true)).toThrow(/historisches Unternehmensprofil/)
    expect(reportingSettingsPayload(JSON.stringify({ companyProfile: profile }), undefined, false)).toContain('Authoritative KG')
    expect(authoritativeEBalanceMasterDataFromSettings(undefined, supplied)).toBe(supplied)
    expect(() => authoritativeEBalanceMasterDataFromSettings(JSON.stringify({ companyProfile: { ...profile, taxNumber: '' } }), supplied)).toThrow(/maßgebliche Unternehmensprofil ist ungültig/)
  })
  it('applies only persisted address confirmation to an incomplete historical profile', () => {
    const historical = { companyName: 'Historic KG', legalForm: 'KG', taxNumber: '98/765/43210', taxOffice: 'Berlin', vatRegime: 'STANDARD', vatFilingFrequency: 'MONTHLY', activity: 'Trade', sizeClass: 'SMALL', chart: 'SKR04', elections: [] }
    const confirmed = profilePayloadWithConfirmedAddress(JSON.stringify(historical), JSON.stringify({ streetAndHouseNumber: 'Old 1', zipCode: '12345', city: 'Oldtown', country: 'DE' }))
    expect(JSON.parse(confirmed).registeredAddress).toMatchObject({ streetAndHouseNumber: 'Old 1', city: 'Oldtown' })
    expect(() => profilePayloadWithConfirmedAddress(JSON.stringify(historical), undefined)).not.toThrow()
  })
  it('does not bootstrap a calendar year over an existing deviating topology', () => { expect(() => validateNumericPeriodBootstrap(false, 1)).toThrow(/Periodentopologie/); expect(() => validateNumericPeriodBootstrap(false, 0)).not.toThrow(); expect(() => validateNumericPeriodBootstrap(true, 2)).not.toThrow() })
  it('bootstraps only a contiguous, non-overlapping posting successor after rollover', () => {
    const proposedStart = new Date('2026-01-01T00:00:00.000Z')
    const proposedEnd = new Date('2026-12-31T23:59:59.999Z')
    expect(() => validatePostingSuccessorBootstrap([{ year: 2025, startsAt: new Date('2025-01-01'), endsAt: new Date('2025-12-31T23:59:59.999Z') }], 2026, proposedStart, proposedEnd)).not.toThrow()
    expect(() => validatePostingSuccessorBootstrap([{ year: 2025, startsAt: new Date('2025-01-01'), endsAt: new Date('2025-12-30T23:59:59.999Z') }], 2026, proposedStart, proposedEnd)).toThrow(/lückenlos/)
    expect(() => validatePostingSuccessorBootstrap([{ year: 2027, startsAt: new Date('2026-06-01'), endsAt: new Date('2027-05-31T23:59:59.999Z') }], 2026, proposedStart, proposedEnd)).toThrow(/überschneiden/)
  })
  it('claims unowned legacy settings only for local no-auth or an operator-mapped credential tenant', () => { const previous = process.env.AUTH_MODE; process.env.AUTH_MODE = 'credentials'; expect(() => validateLegacyLedgerClaim(undefined, 'owner', ['owner'])).toThrow(/nicht eindeutig/); expect(() => validateLegacyLedgerClaim('owner', 'owner', ['owner'])).not.toThrow(); expect(() => validateLegacyLedgerClaim('local', 'local', ['local'])).not.toThrow(); expect(() => validateLegacyLedgerClaim('local', 'local', [])).toThrow(/nicht eindeutig/); expect(() => validateLegacyLedgerClaim('other', 'owner', ['other'])).toThrow(/anderen Mandanten/); process.env.AUTH_MODE = 'none'; expect(() => validateLegacyLedgerClaim(undefined, 'local', [])).not.toThrow(); if (previous === undefined) delete process.env.AUTH_MODE; else process.env.AUTH_MODE = previous })
  it('ignores an operator-mapped legacy record for every nonmatching tenant', () => {
    expect(legacyLedgerClaimApplies('tenant-a', 'tenant-a')).toBe(true)
    expect(legacyLedgerClaimApplies('tenant-a', 'tenant-b')).toBe(false)
    expect(legacyLedgerClaimApplies(undefined, 'tenant-b')).toBe(true)
  })
  it('infers and backfills existing ledger semantics before trusting stale legacy settings', () => { expect(inferExistingLedgerChart([1000, 8400])).toBe('SKR03'); expect(inferExistingLedgerChart([1600, 4400])).toBe('SKR04'); expect(() => inferExistingLedgerChart([8400, 4400])).toThrow(/widersprüchliche/) })

  it('infers account width together with chart and fails closed on mixed signatures', () => {
    expect(inferExistingLedgerProfile([10000, 84000])).toEqual({ chart: 'SKR03', accountLength: 5 })
    expect(inferExistingLedgerProfile([16000, 44000])).toEqual({ chart: 'SKR04', accountLength: 5 })
    expect(() => inferExistingLedgerProfile([8400, 84000])).toThrow(/Kontenlängen-Signaturen/)
    expect(() => inferExistingLedgerProfile([84000, 44000])).toThrow(/Kontenrahmen-/)
  })
  it('requires safely inferable legacy ledger semantics before settings can establish a profile', () => {
    expect(requireLegacyLedgerProfile([1000, 8400], true)).toEqual({ chart: 'SKR03', accountLength: 4 })
    expect(() => requireLegacyLedgerProfile([1234], true)).toThrow(/keinem eindeutigen Kontenrahmen/)
    expect(() => requireLegacyLedgerProfile([], true)).toThrow(/keinem eindeutigen Kontenrahmen/)
    expect(requireLegacyLedgerProfile([], false)).toBeUndefined()
  })

  it('keeps an authoritative ledger profile without inspecting stale account signatures', () => {
    expect(selectBootstrapChart('CUSTOM:active', [8400, 4400], JSON.stringify({ activeChart: 'SKR04' }))).toBe('CUSTOM:active')
  })
  it('uses the selected deviating fiscal period identity for posting-order checks', () => { expect(postingOrderPeriodYear({ year: 2025 })).toBe(2025) })
  it('detects in-place account semantic or chart changes across the posting lock', () => { const account = { id: '1', number: 1600, name: 'Payables', category: 'LIABILITY', eBilanzPosition: 'liability', active: true }; const original = accountSemanticFingerprint('SKR03', [account]); expect(accountSemanticFingerprint('SKR03', [{ ...account }])).toBe(original); expect(accountSemanticFingerprint('SKR04', [account])).not.toBe(original); expect(accountSemanticFingerprint('SKR03', [{ ...account, name: 'Cash', category: 'ASSET' }])).not.toBe(original) })
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
