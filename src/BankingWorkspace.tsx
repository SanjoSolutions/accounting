"use client"

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { api, getJSON } from './Requester'

type LedgerAccount = { id: string; number: number; name: string; category: string }
type BankAccount = { id: string; name: string; iban: string; ledgerAccount: LedgerAccount }
type Suggestion = { openItemId: string; documentNumber: string; partnerName: string; amountCents: number; currency: string; reason: string }
type BankTransaction = { id: string; bookingDate: string; amountCents: number; currency: string; counterpartyName: string | null; remittance: string | null; reviewState: 'UNMATCHED' | 'MATCHED' | 'REVERSED'; activeMatch: { id: string; journalEntryId: string; openItemId: string; amountCents: number; allocations: Array<{ openItemId: string; documentNumber: string; amountCents: number }>; creditCents: number } | null; suggestions: Suggestion[]; suggestedCreditCents: number; bankAccount: BankAccount }

export function BankingWorkspace() {
  const t = useTranslations('Banking'); const locale = useLocale()
  const [ledgerAccounts, setLedgerAccounts] = useState<LedgerAccount[]>([]); const [bankAccounts, setBankAccounts] = useState<BankAccount[]>([]); const [transactions, setTransactions] = useState<BankTransaction[]>([])
  const [name, setName] = useState(''); const [iban, setIban] = useState(''); const [ledgerAccountId, setLedgerAccountId] = useState(''); const [selectedBankAccountId, setSelectedBankAccountId] = useState(''); const [file, setFile] = useState<File | null>(null)
  const [selected, setSelected] = useState<{ transaction: BankTransaction; suggestions: Suggestion[] } | null>(null); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [status, setStatus] = useState('')

  const load = useCallback(async () => {
    try {
      const year = new Date().getFullYear()
      const [ledgerResponse, accountResponse, transactionResponse] = await Promise.all([api.get(`/api/booking-records?year=${year}`), api.get('/api/banking/accounts'), api.get('/api/banking/transactions')])
      const ledger = await getJSON(ledgerResponse); const accounts = await getJSON(accountResponse); const rows = await getJSON(transactionResponse)
      if (!ledgerResponse.ok || !Array.isArray(ledger?.accounts) || !accountResponse.ok || accounts?.success !== true || !transactionResponse.ok || rows?.success !== true) throw new Error(t('loadFailed'))
      const bankLedgerAccounts = (ledger.accounts as LedgerAccount[]).filter(account => account.category === 'ASSET' && /bank/i.test(account.name))
      setLedgerAccounts(bankLedgerAccounts); setBankAccounts(accounts.data); setTransactions(rows.data)
      setLedgerAccountId(current => current || bankLedgerAccounts[0]?.id || ''); setSelectedBankAccountId(current => current || accounts.data[0]?.id || '')
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : t('loadFailed')) }
    finally { setLoading(false) }
  }, [t])
  useEffect(() => { void load() }, [load])

  async function createAccount(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setStatus('')
    try { const response = await api.post('/api/banking/accounts', { name, iban, ledgerAccountId }); const body = await getJSON(response); if (!response.ok || body?.success !== true) throw new Error(body?.error || t('loadFailed')); setStatus(t('accountCreated')); setName(''); setIban(''); await load(); setSelectedBankAccountId(body.data.id) }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : t('loadFailed')) } finally { setBusy(false) }
  }
  async function importStatement(event: FormEvent) {
    event.preventDefault(); if (!file || !selectedBankAccountId) return; setBusy(true); setError(''); setStatus('')
    try { const response = await fetch('/api/banking/statements', { method: 'POST', headers: { 'content-type': file.type || 'application/xml', 'x-bank-account-id': selectedBankAccountId }, body: file }); const body = await getJSON(response); if (!response.ok || body?.success !== true) throw new Error(body?.error || t('loadFailed')); setStatus(t('imported', body.data)); setFile(null); await load() }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : t('loadFailed')) } finally { setBusy(false) }
  }
  async function confirmMatch() {
    if (!selected) return; setBusy(true); setError(''); setStatus('')
    try { const response = await fetch(`/api/banking/transactions/${selected.transaction.id}/matches`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `bank-match-${crypto.randomUUID()}` }, body: JSON.stringify({ allocations: selected.suggestions.map(suggestion => ({ openItemId: suggestion.openItemId, amountCents: suggestion.amountCents })), reason: 'User confirmed the reviewed bank-to-open-item allocation set and retained credit' }) }); const body = await getJSON(response); if (!response.ok || body?.success !== true) throw new Error(body?.error || t('loadFailed')); setStatus(t('matched', { count: selected.suggestions.length, credit: money(selected.transaction.suggestedCreditCents, selected.transaction.currency) })); setSelected(null); await load() }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : t('loadFailed')) } finally { setBusy(false) }
  }
  async function reverseMatch(transaction: BankTransaction) {
    if (!transaction.activeMatch) return; setBusy(true); setError(''); setStatus('')
    try { const response = await fetch(`/api/banking/matches/${transaction.activeMatch.id}/reversals`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': `bank-reversal-${crypto.randomUUID()}` }, body: JSON.stringify({ effectiveDate: new Date().toISOString().slice(0, 10), reason: 'User explicitly reversed the bank reconciliation' }) }); const body = await getJSON(response); if (!response.ok || body?.success !== true) throw new Error(body?.error || t('loadFailed')); setStatus(t('reversed')); await load() }
    catch (submitError) { setError(submitError instanceof Error ? submitError.message : t('loadFailed')) } finally { setBusy(false) }
  }
  if (loading) return <p>{t('loading')}</p>
  const money = (amount: number, currency: string) => new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amount / 100)
  return <div className="container-fluid px-0">
    <header className="mb-4"><h1>{t('title')}</h1><p className="text-muted">{t('subtitle')}</p></header>
    {error && <div className="alert alert-danger" role="alert">{error}</div>}{status && <div className="alert alert-success" role="status">{status}</div>}
    <div className="row g-4"><section className="col-lg-6"><div className="card"><div className="card-body"><h2 className="h4">{t('newAccount')}</h2><form onSubmit={createAccount}>
      <label className="form-label" htmlFor="bank-name">{t('accountName')}</label><input required id="bank-name" className="form-control mb-3" value={name} onChange={event => setName(event.target.value)} />
      <label className="form-label" htmlFor="bank-iban">{t('iban')}</label><input required id="bank-iban" className="form-control mb-3" value={iban} onChange={event => setIban(event.target.value)} />
      <label className="form-label" htmlFor="ledger-bank-account">{t('ledgerAccount')}</label><select required id="ledger-bank-account" className="form-select mb-3" value={ledgerAccountId} onChange={event => setLedgerAccountId(event.target.value)}>{ledgerAccounts.map(account => <option value={account.id} key={account.id}>{account.number} · {account.name}</option>)}</select>
      <button disabled={busy || !ledgerAccountId} className="btn btn-primary">{t('createAccount')}</button></form></div></div></section>
      <section className="col-lg-6"><div className="card"><div className="card-body"><h2 className="h4">{t('upload')}</h2><form onSubmit={importStatement}>
        <label className="form-label" htmlFor="statement-account">{t('bankAccount')}</label><select required id="statement-account" className="form-select mb-3" value={selectedBankAccountId} onChange={event => setSelectedBankAccountId(event.target.value)}><option value="" />{bankAccounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.iban}</option>)}</select>
        <label className="form-label" htmlFor="statement-file">{t('statementFile')}</label><input required accept=".xml,application/xml,text/xml" type="file" id="statement-file" className="form-control mb-3" onChange={event => setFile(event.target.files?.[0] ?? null)} />
        <button disabled={busy || !file || !selectedBankAccountId} className="btn btn-primary">{t('import')}</button></form></div></div></section></div>
    <section className="mt-5"><h2 className="h4">{t('transactions')}</h2>{transactions.length ? <div className="table-responsive"><table className="table"><thead><tr><th>{t('date')}</th><th>{t('counterparty')}</th><th>{t('purpose')}</th><th>{t('amount')}</th><th>{t('reviewState')}</th><th>{t('suggestion')}</th></tr></thead><tbody>{transactions.map(transaction => <tr key={transaction.id}><td>{transaction.bookingDate.slice(0, 10)}</td><td>{transaction.counterpartyName || '—'}</td><td>{transaction.remittance || '—'}</td><td>{money(transaction.amountCents, transaction.currency)}</td><td><span className={`badge ${transaction.reviewState === 'MATCHED' ? 'text-bg-success' : 'text-bg-warning'}`}>{t(transaction.reviewState === 'MATCHED' ? 'matchedState' : transaction.reviewState === 'REVERSED' ? 'reversedState' : 'unmatched')}</span></td><td>{transaction.activeMatch ? <div><p className="mb-1 small">{t('allocationSummary', { count: transaction.activeMatch.allocations.length, credit: money(transaction.activeMatch.creditCents, transaction.currency) })}</p><button disabled={busy} className="btn btn-sm btn-outline-danger" onClick={() => void reverseMatch(transaction)}>{t('reverse')}</button></div> : transaction.suggestions.length ? <button className="btn btn-sm btn-outline-primary" onClick={() => setSelected({ transaction, suggestions: transaction.suggestions })}>{t('review')} · {t('invoiceCount', { count: transaction.suggestions.length })}</button> : t('noSuggestion')}</td></tr>)}</tbody></table></div> : <p>{t('noTransactions')}</p>}</section>
    {selected && <section className="card mt-4" aria-labelledby="bank-review-heading"><div className="card-body"><h2 id="bank-review-heading" className="h4">{t('reviewTitle')}</h2><div className="alert alert-warning" role="alert">{t('reviewWarning')}</div><div className="table-responsive"><table className="table"><thead><tr><th>{t('document')}</th><th>{t('partner')}</th><th>{t('amount')}</th><th>{t('reason')}</th></tr></thead><tbody>{selected.suggestions.map(suggestion => <tr key={suggestion.openItemId}><td>{suggestion.documentNumber}</td><td>{suggestion.partnerName}</td><td>{money(suggestion.amountCents, suggestion.currency)}</td><td>{suggestion.reason}</td></tr>)}</tbody></table></div><p className="fw-semibold">{t('retainedCredit', { credit: money(selected.transaction.suggestedCreditCents, selected.transaction.currency) })}</p><div className="d-flex gap-2"><button disabled={busy} className="btn btn-primary" onClick={() => void confirmMatch()}>{t('confirm')}</button><button className="btn btn-secondary" onClick={() => setSelected(null)}>{t('closeReview')}</button></div></div></section>}
  </div>
}
