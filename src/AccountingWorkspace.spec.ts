import { describe, expect, it } from 'vitest'
import {
  bookingFormRows,
  bookingWorkspaceStorageKey,
  clearBookingWorkspaceState,
  consumeBookingWorkspaceSaveSuppression,
  defaultContinueWithSameDocuments,
  documentStateAfterPosting,
  getBrowserBookingWorkspaceStorage,
  isBookingFormDisabled,
  loadBookingWorkspaceState,
  parseBookingWorkspaceState,
  persistBookingWorkspaceStateChange,
  saveBookingWorkspaceState,
  shouldApplyWorkspace,
  shouldShowPostingLineRemoveButtons,
  workspaceSections,
  type BookingWorkspaceState,
} from './AccountingWorkspace'
import { availableBookingAccounts, sanitizeBookingAccountSelections } from './core/doubleEntry'

const accounts = [
  { id: 'bank', category: 'ASSET' },
  { id: 'payable', category: 'LIABILITY' },
  { id: 'capital', category: 'EQUITY' },
  { id: 'revenue', category: 'REVENUE' },
  { id: 'expense', category: 'EXPENSE' },
]

describe('accounting workspace request ordering', () => {
  it('separates booking, journal, and dashboard content between their pages', () => {
    expect(workspaceSections('booking')).toEqual({ booking: true, journal: false, metrics: false })
    expect(workspaceSections('journal')).toEqual({ booking: false, journal: true, metrics: false })
    expect(workspaceSections('dashboard')).toEqual({ booking: false, journal: false, metrics: true })
  })

  it('applies only a non-aborted response for the currently selected year', () => {
    expect(shouldApplyWorkspace(2026, 2026, false)).toBe(true)
    expect(shouldApplyWorkspace(2025, 2026, false)).toBe(false)
    expect(shouldApplyWorkspace(2026, 2026, true)).toBe(false)
    expect(shouldApplyWorkspace(2026, 2026, false, 1, 2)).toBe(false)
    expect(shouldApplyWorkspace(2026, 2026, false, 2, 2)).toBe(true)
  })

  it('locks every booking input while a posting is being transferred', () => {
    expect(isBookingFormDisabled(true)).toBe(true)
    expect(isBookingFormDisabled(false)).toBe(false)
    expect(isBookingFormDisabled(false, true)).toBe(true)
    expect(isBookingFormDisabled(false, false, true)).toBe(true)
  })

  it('shows posting-line remove buttons only when more than two lines exist', () => {
    expect(shouldShowPostingLineRemoveButtons(0)).toBe(false)
    expect(shouldShowPostingLineRemoveButtons(1)).toBe(false)
    expect(shouldShowPostingLineRemoveButtons(2)).toBe(false)
    expect(shouldShowPostingLineRemoveButtons(3)).toBe(true)
  })

  it('does not continue with the same documents by default', () => {
    expect(defaultContinueWithSameDocuments).toBe(false)
  })

  it('removes posted documents from the inbox unless continuing with them', () => {
    expect(documentStateAfterPosting(['document-1', 'document-2'], false)).toEqual({
      selectedDocumentIds: [],
      unavailableDocumentIds: ['document-1', 'document-2'],
    })
    expect(documentStateAfterPosting(['document-1', 'document-2'], true)).toEqual({
      selectedDocumentIds: ['document-1', 'document-2'],
      unavailableDocumentIds: [],
    })
  })

  it('places posting text in its own full-width row', () => {
    expect(bookingFormRows()).toEqual([['bookingDate'], ['description']])
  })

  it('offers only unused balance-sheet accounts after a P&L account is selected first', () => {
    const lines = [{ accountId: 'expense' }, { accountId: '' }]
    expect(availableBookingAccounts(accounts, lines, 1).map(account => account.id)).toEqual(['bank', 'payable', 'capital'])
  })

  it('offers every unused account after a balance-sheet account makes the combination valid', () => {
    const lines = [{ accountId: 'expense' }, { accountId: 'bank' }, { accountId: '' }]
    expect(availableBookingAccounts(accounts, lines, 2).map(account => account.id)).toEqual(['payable', 'capital', 'revenue'])
  })

  it('clears dependent account choices that become invalid after an earlier selection changes', () => {
    expect(sanitizeBookingAccountSelections(accounts, [
      { accountId: 'expense', debit: '10', credit: '' },
      { accountId: 'revenue', debit: '', credit: '10' },
    ])).toEqual([
      { accountId: 'expense', debit: '10', credit: '' },
      { accountId: '', debit: '', credit: '10' },
    ])
  })

  it('persists and restores the complete in-progress booking state', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const state: BookingWorkspaceState = {
      year: 2025,
      bookingDate: '2025-06-18',
      description: 'Office supplies',
      lines: [
        { accountId: 'office', debit: '119.00', credit: '' },
        { accountId: 'bank', debit: '', credit: '119.00' },
      ],
      selectedDocumentIds: ['document-1'],
    }

    saveBookingWorkspaceState(storage, 'user-1', state)

    expect(loadBookingWorkspaceState(storage, 'user-1')).toEqual(state)
    expect(loadBookingWorkspaceState(storage, 'user-2')).toBeNull()
  })

  it('persists Buchungstext synchronously when it changes', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }
    const state: BookingWorkspaceState = {
      year: 2026,
      bookingDate: '2026-07-17',
      description: '',
      lines: [
        { accountId: '', debit: '', credit: '' },
        { accountId: '', debit: '', credit: '' },
      ],
      selectedDocumentIds: [],
    }

    const nextState = persistBookingWorkspaceStateChange(
      storage, 'user-1', state, { description: 'Sofort gespeicherter Buchungstext' },
    )

    expect(nextState.description).toBe('Sofort gespeicherter Buchungstext')
    expect(loadBookingWorkspaceState(storage, 'user-1')?.description).toBe('Sofort gespeicherter Buchungstext')
  })

  it('ignores malformed persisted booking state', () => {
    expect(parseBookingWorkspaceState('{not-json')).toBeNull()
    expect(parseBookingWorkspaceState(JSON.stringify({ year: 2025, lines: [] }))).toBeNull()
  })

  it('restores a legacy draft without carrying its manual document number forward', () => {
    const state = parseBookingWorkspaceState(JSON.stringify({
      year: 2026,
      bookingDate: '2026-07-17',
      documentNumber: 'LEGACY-42',
      description: 'Legacy draft',
      lines: [
        { accountId: 'expense', debit: '10', credit: '' },
        { accountId: 'bank', debit: '', credit: '10' },
      ],
      selectedDocumentIds: ['document-1'],
    }))

    expect(state).not.toHaveProperty('documentNumber')
    expect(state?.selectedDocumentIds).toEqual(['document-1'])
  })

  it('keeps the last valid draft when persisting the replacement fails', () => {
    const values = new Map<string, string>()
    let rejectWrites = false
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (rejectWrites) throw new DOMException('Quota exceeded', 'QuotaExceededError')
        values.set(key, value)
      },
      removeItem: (key: string) => { values.delete(key) },
    }
    const state: BookingWorkspaceState = {
      year: 2025,
      bookingDate: '2025-06-18',
      description: 'Office supplies',
      lines: [
        { accountId: 'office', debit: '119.00', credit: '' },
        { accountId: 'bank', debit: '', credit: '119.00' },
      ],
      selectedDocumentIds: [],
    }
    saveBookingWorkspaceState(storage, 'user-1', state)
    rejectWrites = true

    saveBookingWorkspaceState(storage, 'user-1', { ...state, description: 'Newer text' })

    expect(loadBookingWorkspaceState(storage, 'user-1')).toEqual(state)
  })

  it('clears only the current user draft after a successful posting', () => {
    const values = new Map<string, string>([
      [bookingWorkspaceStorageKey('user-1'), '{}'],
      [bookingWorkspaceStorageKey('user-2'), '{}'],
    ])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    }

    expect(clearBookingWorkspaceState(storage, 'user-1')).toBe(true)

    expect(values.has(bookingWorkspaceStorageKey('user-1'))).toBe(false)
    expect(values.has(bookingWorkspaceStorageKey('user-2'))).toBe(true)
  })

  it('reports a failed clear so the reset state can be saved as a fallback', () => {
    const storage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => { throw new DOMException('Access denied', 'SecurityError') },
    }

    expect(clearBookingWorkspaceState(storage, 'user-1')).toBe(false)
  })

  it('suppresses only the autosave caused by resetting a successful posting', () => {
    const suppression = { current: true }

    expect(consumeBookingWorkspaceSaveSuppression(suppression)).toBe(true)
    expect(consumeBookingWorkspaceSaveSuppression(suppression)).toBe(false)
  })

  it('falls back to in-memory state when access to localStorage is denied', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: Object.defineProperty({}, 'localStorage', {
        get: () => { throw new DOMException('Access denied', 'SecurityError') },
      }),
    })
    try {
      expect(getBrowserBookingWorkspaceStorage()).toBeNull()
    } finally {
      Reflect.deleteProperty(globalThis, 'window')
    }
  })

})
