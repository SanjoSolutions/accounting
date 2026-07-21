"use client"

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { isBalanceSheetAccountCategory, type AccountCategory } from './core/doubleEntry'

export type SelectableAccount = { id: string; number: number; name: string; category: AccountCategory }

type AccountSelectorProps = {
  accounts: SelectableAccount[]
  value: string
  label: string
  chooseLabel: string
  searchLabel: string
  noResultsLabel: string
  balanceSheetLabel: string
  profitAndLossLabel: string
  onChange: (accountId: string) => void
}

export function AccountSelector({
  accounts, value, label, chooseLabel, searchLabel, noResultsLabel,
  balanceSheetLabel, profitAndLossLabel, onChange,
}: AccountSelectorProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  const selectedAccount = accounts.find(account => account.id === value)
  const filteredAccounts = useMemo(() => filterDisplayAccounts(accounts, search), [accounts, search])
  const balanceSheetAccounts = filteredAccounts.filter(account => isBalanceSheetAccountCategory(account.category))
  const profitAndLossAccounts = filteredAccounts.filter(account => !isBalanceSheetAccountCategory(account.category))

  useEffect(() => {
    if (!open) return
    focusAccountSearchInput(searchRef.current)
    const closeWhenClickingOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', closeWhenClickingOutside)
    return () => document.removeEventListener('mousedown', closeWhenClickingOutside)
  }, [open])

  function close(restoreFocus = false) {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }

  function select(accountId: string) {
    onChange(accountId)
    close(true)
  }

  return <div className="account-selector" ref={rootRef}>
    <input
      className="account-selector-required-input"
      value={value}
      onChange={() => undefined}
      required
      tabIndex={-1}
      aria-hidden="true"
      onInvalid={event => {
        event.preventDefault()
        setSearch('')
        setOpen(true)
      }}
    />
    <button
      ref={triggerRef}
      className="form-select account-selector-trigger"
      type="button"
      role="combobox"
      aria-label={label}
      aria-expanded={open}
      aria-controls={listboxId}
      aria-haspopup="listbox"
      onClick={() => {
        setSearch('')
        setOpen(current => !current)
      }}
    >
      {selectedAccount ? accountDisplayName(selectedAccount) : chooseLabel}
    </button>
    {open && <div className="account-selector-dropdown" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close(true) }
    }}>
      <input
        ref={searchRef}
        className="form-control account-selector-search"
        value={search}
        onChange={event => setSearch(event.target.value)}
        placeholder={searchLabel}
        aria-label={searchLabel}
      />
      <div className="account-selector-options" id={listboxId} role="listbox" aria-label={label}>
        {filteredAccounts.length === 0 && <p className="account-selector-empty">{noResultsLabel}</p>}
        <AccountGroup label={balanceSheetLabel} accounts={balanceSheetAccounts} value={value} onSelect={select} />
        <AccountGroup label={profitAndLossLabel} accounts={profitAndLossAccounts} value={value} onSelect={select} />
      </div>
    </div>}
  </div>
}

function AccountGroup({ label, accounts, value, onSelect }: {
  label: string
  accounts: SelectableAccount[]
  value: string
  onSelect: (accountId: string) => void
}) {
  if (accounts.length === 0) return null
  return <section className="account-selector-group" aria-label={label}>
    <div className="account-selector-group-label">{label}</div>
    {accounts.map(account => <button
      type="button"
      role="option"
      aria-selected={account.id === value}
      className="account-selector-option"
      key={account.id}
      onClick={() => onSelect(account.id)}
    >{accountDisplayName(account)}</button>)}
  </section>
}

export function filterDisplayAccounts(accounts: SelectableAccount[], search: string) {
  const query = normalizeAccountSearch(search)
  if (!query) return accounts
  return accounts.filter(account => normalizeAccountSearch(accountDisplayName(account)).includes(query))
}

export function focusAccountSearchInput(input: Pick<HTMLInputElement, 'focus'> | null) {
  input?.focus()
}

function accountDisplayName(account: SelectableAccount) {
  return `${account.number} · ${account.name}`
}

function normalizeAccountSearch(value: string) {
  return value.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
}
