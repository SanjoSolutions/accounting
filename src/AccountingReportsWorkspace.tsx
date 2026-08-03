"use client"

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { FiscalYearNavigation } from './FiscalYearNavigation'
import {
  accountingReportEndpoint,
  filterAccountingReportAccounts,
  type AccountingReportAddress,
  type AccountingReportLedgerEntry,
  type AccountingReportResponse,
} from './accountingReports'

function formatAddress(address: AccountingReportAddress) {
  return `${address.street} ${address.houseNumber}, ${address.postalCode} ${address.city}${address.region ? `, ${address.region}` : ''}`
}

function Money({ cents, currency }: { cents: number; currency: string }) {
  return <span className="text-nowrap">{new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
  }).format(cents / 100)}</span>
}

function EntryRows({ entries, currency, voucherLabel }: {
  entries: readonly AccountingReportLedgerEntry[]
  currency: string
  voucherLabel: string
}) {
  return entries.map(entry => <tr key={entry.id}>
    <td>{entry.sourcePostingDate ?? '—'}</td>
    <td>{entry.sourceJournalDate ?? '—'}</td>
    <td>{entry.voucherDate}</td>
    <td>{entry.sourcePeriod ?? '—'}</td>
    <td><Link href={entry.journalVoucherHref}>{voucherLabel}: {entry.voucherNumber}</Link></td>
    <td>{entry.postingText}</td>
    <td>{entry.counterAccountNumbers.join(', ') || '—'}</td>
    <td>{entry.vatAccountNumber ? `${entry.vatAccountNumber}${entry.vatRateBasisPoints === undefined ? '' : ` · ${entry.vatRateBasisPoints / 100}%`}` : '—'}</td>
    <td className="text-end"><Money cents={entry.debitCents} currency={currency} /></td>
    <td className="text-end"><Money cents={entry.creditCents} currency={currency} /></td>
    <td className="text-end"><Money cents={entry.runningBalanceCents} currency={currency} /></td>
  </tr>)
}

export function AccountingReportsView({ report }: { report: AccountingReportResponse }) {
  const t = useTranslations('AccountingReports')
  const [accountQuery, setAccountQuery] = useState('')
  const accounts = useMemo(
    () => filterAccountingReportAccounts(report.accounts, accountQuery),
    [accountQuery, report.accounts],
  )
  const currency = report.setup.currency

  return <>
    <header className="page-heading">
      <div><span className="eyebrow">{t('eyebrow')}</span><h1>{t('title', { year: report.year })}</h1><p>{t('subtitle')}</p></div>
    </header>

    <div className="close-grid">
      <section className="card panel">
        <h2>{t('company')}</h2>
        <dl className="report-definition-list">
          <dt>{t('companyName')}</dt><dd>{report.company.name}</dd>
          <dt>{t('address')}</dt><dd>{formatAddress(report.company.address)}</dd>
        </dl>
      </section>
      <section className="card panel">
        <h2>{t('setup')}</h2>
        <dl className="report-definition-list">
          <dt>{t('fiscalPeriod')}</dt><dd>{report.setup.fiscalYearStartsAt} – {report.setup.fiscalYearEndsAt}</dd>
          <dt>{t('chart')}</dt><dd>{report.setup.chart}</dd>
          <dt>{t('accountingMethod')}</dt><dd>{report.setup.accountingMethod}</dd>
          <dt>{t('profitDetermination')}</dt><dd>{report.setup.profitDetermination}</dd>
          <dt>{t('taxonomyVersion')}</dt><dd>{report.setup.taxonomyVersion}</dd>
          <dt>{t('currency')}</dt><dd>{currency}</dd>
        </dl>
      </section>
    </div>

    <section className="card panel mt-4">
      <div className="report-section-heading">
        <div><h2>{t('chartMetadata')}</h2><p>{t('accountsShown', { shown: accounts.length, total: report.accounts.length })}</p></div>
        <label>{t('searchAccounts')}<input className="form-control" type="search" value={accountQuery} onChange={event => setAccountQuery(event.target.value)} /></label>
      </div>
      <div className="table-responsive"><table className="table">
        <thead><tr><th>{t('account')}</th><th>{t('name')}</th><th>{t('type')}</th><th>{t('subcategory')}</th><th>{t('vatOld')}</th><th>{t('vatCurrent')}</th><th>{t('cashBasisMapping')}</th><th>{t('hgbPosition')}</th><th>{t('hgbMapping')}</th><th>{t('eBilanzPosition')}</th></tr></thead>
        <tbody>{accounts.map(account => <tr key={account.number}><td>{account.number}</td><td>{account.name}</td><td>{account.type}</td><td>{account.subcategory ?? '—'}</td><td>{[account.vatPositionOld, account.vatCodeOld].filter(Boolean).join(' / ') || '—'}</td><td>{[account.vatPositionCurrent, account.vatCodeCurrent].filter(Boolean).join(' / ') || '—'}</td><td>{account.cashBasisMapping ?? '—'}</td><td>{account.hgbPosition}</td><td>{account.hgbMapping ?? '—'}</td><td>{account.eBilanzPosition ?? '—'}</td></tr>)}</tbody>
      </table></div>
      {!accounts.length && <p>{t('noAccounts')}</p>}
    </section>

    <section className="card panel mt-4">
      <h2>{t('trialBalance')}</h2>
      <div className="table-responsive"><table className="table">
        <thead><tr><th>{t('account')}</th><th>{t('name')}</th><th>{t('lastBookingDate')}</th><th className="text-end">{t('openingDebit')}</th><th className="text-end">{t('openingCredit')}</th><th className="text-end">{t('annualDebit')}</th><th className="text-end">{t('annualCredit')}</th><th className="text-end">{t('cumulativeDebit')}</th><th className="text-end">{t('cumulativeCredit')}</th><th className="text-end">{t('closingDebit')}</th><th className="text-end">{t('closingCredit')}</th></tr></thead>
        <tbody>{report.trialBalance.map(row => <tr key={row.accountNumber}><td>{row.accountNumber}</td><td>{row.accountName}</td><td>{row.lastBookingDate ?? '—'}</td>{[row.openingDebitCents, row.openingCreditCents, row.annualDebitCents, row.annualCreditCents, row.cumulativeDebitCents, row.cumulativeCreditCents, row.closingDebitCents, row.closingCreditCents].map((cents, index) => <td className="text-end" key={index}><Money cents={cents} currency={currency} /></td>)}</tr>)}</tbody>
      </table></div>
    </section>

    <section className="card panel mt-4">
      <h2>{t('generalLedger')}</h2>
      {report.generalLedger.map(sheet => <details className="report-details" key={sheet.accountNumber}>
        <summary>{sheet.accountNumber} · {sheet.accountName} — <Money cents={sheet.closingBalanceCents} currency={currency} /></summary>
        <div className="table-responsive"><table className="table">
          <thead><tr><th>{t('sourcePostingDate')}</th><th>{t('sourceJournalDate')}</th><th>{t('voucherDate')}</th><th>{t('sourcePeriod')}</th><th>{t('voucher')}</th><th>{t('postingText')}</th><th>{t('counterAccounts')}</th><th>{t('vat')}</th><th className="text-end">{t('debit')}</th><th className="text-end">{t('credit')}</th><th className="text-end">{t('balance')}</th></tr></thead>
          <tbody><EntryRows entries={sheet.entries} currency={currency} voucherLabel={t('voucher')} /></tbody>
        </table></div>
      </details>)}
    </section>

    <section className="card panel mt-4">
      <h2>{t('counterparties')}</h2>
      {report.counterparties.map(counterparty => <details className="report-details" key={counterparty.id}>
        <summary>{t(counterparty.kind)} {counterparty.accountNumber} · {counterparty.name} — <Money cents={counterparty.balanceCents} currency={currency} /></summary>
        <p>{t('partyNumber')}: {counterparty.partyNumber} · {formatAddress(counterparty.address)}{counterparty.industry ? ` · ${counterparty.industry}` : ''}</p>
        <div className="table-responsive"><table className="table">
          <thead><tr><th>{t('sourcePostingDate')}</th><th>{t('sourceJournalDate')}</th><th>{t('voucherDate')}</th><th>{t('sourcePeriod')}</th><th>{t('voucher')}</th><th>{t('postingText')}</th><th>{t('counterAccounts')}</th><th>{t('vat')}</th><th className="text-end">{t('debit')}</th><th className="text-end">{t('credit')}</th><th className="text-end">{t('balance')}</th></tr></thead>
          <tbody><EntryRows entries={counterparty.entries} currency={currency} voucherLabel={t('voucher')} /></tbody>
        </table></div>
      </details>)}
    </section>

    <section className="card panel mt-4">
      <h2>{t('annualVatStatement')}</h2>
      <div className="table-responsive"><table className="table">
        <thead><tr><th>{t('code')}</th><th className="text-end">{t('value')}</th></tr></thead>
        <tbody>{report.annualVatStatement.fields.map(field => <tr key={field.code}><td>{field.code}</td><td className="text-end"><Money cents={field.valueCents} currency={currency} /></td></tr>)}</tbody>
      </table></div>
    </section>
  </>
}

export function AccountingReportsWorkspace({ year }: { year: number }) {
  const t = useTranslations('AccountingReports')
  const [report, setReport] = useState<AccountingReportResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(false)
    setReport(null)
    void fetch(accountingReportEndpoint(year), { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('load')
        return response.json() as Promise<AccountingReportResponse>
      })
      .then(data => { setReport(data); setLoading(false) })
      .catch(loadError => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return
        setError(true)
        setLoading(false)
      })
    return () => controller.abort()
  }, [year])

  return <div className="workspace pb-4">
    <FiscalYearNavigation area="reports" year={year} />
    {loading && <p role="status">{t('loading')}</p>}
    {error && <p className="alert alert-danger" role="alert">{t('loadFailed')}</p>}
    {report && <AccountingReportsView report={report} />}
  </div>
}
