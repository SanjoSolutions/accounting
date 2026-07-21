import { describe, expect, it, vi } from 'vitest'
import { filterDisplayAccounts, focusAccountSearchInput, type SelectableAccount } from './AccountSelector'

const accounts: SelectableAccount[] = [
  { id: 'bank', number: 1200, name: 'Bank', category: 'ASSET' },
  { id: 'office', number: 4930, name: 'Bürobedarf', category: 'EXPENSE' },
  { id: 'revenue', number: 8400, name: 'Erlöse 19 % USt', category: 'REVENUE' },
]

describe('account selector', () => {
  it('filters display accounts by account number or name without case or accent sensitivity', () => {
    expect(filterDisplayAccounts(accounts, '493').map(account => account.id)).toEqual(['office'])
    expect(filterDisplayAccounts(accounts, 'BURO').map(account => account.id)).toEqual(['office'])
    expect(filterDisplayAccounts(accounts, 'erlöse').map(account => account.id)).toEqual(['revenue'])
    expect(filterDisplayAccounts(accounts, 'missing')).toEqual([])
  })

  it('focuses the search input when the dropdown opens', () => {
    const focus = vi.fn()

    focusAccountSearchInput({ focus } as Pick<HTMLInputElement, 'focus'>)

    expect(focus).toHaveBeenCalledOnce()
  })
})
