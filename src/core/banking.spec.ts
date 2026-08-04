import { describe, expect, it } from 'vitest'
import { BankStatementValidationError, parseCamt053 } from './banking'

function camt(entries = `<Ntry><Amt Ccy="EUR">119.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-08-04</Dt></BookgDt><ValDt><Dt>2026-08-04</Dt></ValDt><NtryRef>bank-ref-1</NtryRef><NtryDtls><TxDtls><Refs><AcctSvcrRef>bank-ref-1</AcctSvcrRef></Refs><RltdPties><Dbtr><Nm>Musterkunde GmbH</Nm></Dbtr><DbtrAcct><Id><IBAN>DE12500105170648489890</IBAN></Id></DbtrAcct></RltdPties><RmtInf><Ustrd>Invoice 2026-000001</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`, closing = '1119.00') {
  return `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>statement-2026-08</Id><FrToDt><FrDtTm>2026-08-01T00:00:00Z</FrDtTm><ToDtTm>2026-08-31T23:59:59Z</ToDtTm></FrToDt><Acct><Id><IBAN>DE44500105175407324931</IBAN></Id></Acct><Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal><Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${closing}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>${entries}</Stmt></BkToCstmrStmt></Document>`
}

describe('CAMT.053 bank statement parser', () => {
  it('Given a booked EUR receipt, when the statement is parsed, then exact cents and review facts are returned', () => {
    const result = parseCamt053(camt())
    expect(result).toMatchObject({ externalStatementId: 'statement-2026-08', iban: 'DE44500105175407324931', openingBalanceCents: 100_000, closingBalanceCents: 111_900 })
    expect(result.transactions).toHaveLength(1)
    expect(result.transactions[0]).toMatchObject({ amountCents: 11_900, bookingDate: '2026-08-04', bankReference: 'bank-ref-1', counterpartyName: 'Musterkunde GmbH', counterpartyIban: 'DE12500105170648489890', remittance: 'Invoice 2026-000001' })
    expect(result.transactions[0].externalKey).toMatch(/^[a-f0-9]{64}$/)
  })

  it('Given a debit entry, when parsed, then its signed cents reduce the reconciled statement balance', () => {
    const entry = `<Ntry><Amt Ccy="EUR">25.50</Amt><CdtDbtInd>DBIT</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-08-05</Dt></BookgDt><NtryRef>debit-1</NtryRef></Ntry>`
    expect(parseCamt053(camt(entry, '974.50')).transactions[0].amountCents).toBe(-2550)
  })

  it.each([
    ['unbalanced totals', camt(undefined, '1118.99'), /does not equal/],
    ['pending entries', camt(camt().match(/<Ntry>[\s\S]*<\/Ntry>/)![0].replace('<Cd>BOOK</Cd>', '<Cd>PDNG</Cd>')), /Only booked/],
    ['non-EUR money', camt().replaceAll('Ccy="EUR"', 'Ccy="USD"'), /Only EUR/],
    ['entity declarations', `<!DOCTYPE x [<!ENTITY secret "x">]>${camt()}`, /DTD and entity/],
    ['duplicate bank references', camt(`${camt().match(/<Ntry>[\s\S]*<\/Ntry>/)![0]}${camt().match(/<Ntry>[\s\S]*<\/Ntry>/)![0]}`, '1238.00'), /occurs more than once/],
  ])('Given %s, when parsed, then the import fails closed', (_name, xml, message) => {
    expect(() => parseCamt053(xml)).toThrow(message)
  })

  it('Given malformed XML, when parsed, then a stable validation error is raised', () => {
    expect(() => parseCamt053('<Document>')).toThrow(BankStatementValidationError)
  })
})
