import { eBalanceChecksum, type EBalanceExportDataset } from './eBilanzExport'
import { canonicalJson } from './compliance/auditExport'
import { centsText, xmlEscape as esc, XMLNS } from './eBilanzXml'

export function serializeEBalanceFilingXml(dataset: EBalanceExportDataset, remoteSchemas = false) {
  const { company, fiscalYear, taxonomy, reconciliation } = dataset
  const gcd = reconciliation.payload.gcd
  const street = company.street.endsWith(` ${gcd.houseNumber}`) ? company.street.slice(0, -(gcd.houseNumber.length + 1)) : company.street
  const item = (prefix: string, name: string, value: string | null, context = 'duration', monetary = false) => `<${prefix}:${name} contextRef="${context}"${monetary ? ' unitRef="EUR" decimals="2"' : ''}${value === null ? ' xsi:nil="true"/>' : `>${esc(value)}</${prefix}:${name}>`}`
  const g = (name: string, value: string | null) => item('de-gcd', `genInfo.${name}`, value)
  const nilWithReason = (name: string, value: string | null, reasonKey: string) => {
    if (value === null && !reconciliation.payload.nilReasons[reasonKey]?.trim()) throw new Error(`Explicit nil reason required for ${reasonKey}.`)
    return g(name, value)
  }
  const tuple = (name: string, body: string) => `<de-gcd:genInfo.${name}>${body}</de-gcd:genInfo.${name}>`
  const choice = (name: string, option: string) => tuple(name, g(`${name}.${option}`, ''))
  const entity = `<xbrli:entity><xbrli:identifier scheme="http://www.rzf-nrw.de/Steuernummer">${esc(company.taxNumber)}</xbrli:identifier></xbrli:entity>`
  const duration = `<xbrli:period><xbrli:startDate>${fiscalYear.startsAt}</xbrli:startDate><xbrli:endDate>${fiscalYear.endsAt}</xbrli:endDate></xbrli:period>`
  const contexts = [
    `<xbrli:context id="duration">${entity}${duration}</xbrli:context>`,
    `<xbrli:context id="instant">${entity}<xbrli:period><xbrli:instant>${fiscalYear.endsAt}</xbrli:instant></xbrli:period></xbrli:context>`,
  ]
  const assetFacts: string[] = []
  const assetConcepts = [...new Set(dataset.assets.map(asset => asset.concept))].sort()
  for (const [index, concept] of assetConcepts.entries()) {
    const context = `assets-${index}`
    contexts.push(`<xbrli:context id="${context}">${entity}${duration}<xbrli:scenario><xbrldi:explicitMember dimension="de-gaap-ci:dim_taxTrans">de-gaap-ci:dim_taxBal</xbrldi:explicitMember><xbrldi:explicitMember dimension="de-gaap-ci:dim_changes.nt.ass.gross">de-gaap-ci:${concept}</xbrldi:explicitMember></xbrli:scenario></xbrli:context>`)
    const rows = dataset.assets.filter(asset => asset.concept === concept).map(asset => asset.tax)
    const total = (field: keyof typeof rows[number]) => rows.reduce((sum, row) => sum + Number(row[field]), 0)
    const facts: Record<string, number> = {
      all: total('carryingAmountCents'), gross: total('closingCostCents'), 'grossCost.beginning': total('openingCostCents'),
      'gross.addition': total('additionsCents'), 'gross.release': total('disposalsCents'), 'gross.movements': total('acquisitionCostTransfersCents'),
      accDepr: total('closingAccumulatedDepreciationCents'), 'accDepr.beginning': total('openingAccumulatedDepreciationCents'),
      'accDepr.DeprPeriod': total('currentDepreciationCents') + total('impairmentsCents'),
      'accDepr.DeprPeriod.regular': total('currentDepreciationCents'), 'accDepr.DeprPeriod.impairment': total('impairmentsCents'),
      'accDepr.release': total('depreciationRemovedOnDisposalCents'), 'accDepr.movements': total('accumulatedDepreciationTransfersCents'),
      revaluation: total('reversalsCents'), all_Prev_period: total('openingCostCents') - total('openingAccumulatedDepreciationCents'),
    }
    for (const [name, amount] of Object.entries(facts)) assetFacts.push(item('de-gaap-ci', name, centsText(amount), context, true))
  }
  const reportElements = ['B', 'BVV', 'EB', 'GuV', 'BAL', 'EV', 'STU', 'KS']
    .map(name => g(`report.id.reportElement.reportElements.${name}`, ['B', 'BVV', 'GuV', 'KS', ...(dataset.assets.length ? ['BAL'] : [])].includes(name) ? '' : null)).join('')
  const gcdFacts = [
    g('doc.id.generationDate', dataset.generationDate),
    choice('report.id.reportStatus', 'reportStatus.E'), choice('report.id.revisionStatus', 'revisionStatus.E'),
    tuple('report.id.reportElement', reportElements), choice('report.id.statementType', 'statementType.E'),
    g('report.id.reportElement.reportElements.transmissionNotYetPossible', null),
    g('report.id.incomeStatementendswithBalProfit', 'false'), choice('report.id.accountingStandard', 'accountingStandard.S'),
    choice('report.id.specialAccountingStandard', 'K'), choice('report.id.incomeStatementFormat', 'incomeStatementFormat.GKV'),
    choice('report.id.consolidationRange', 'consolidationRange.EA'),
    g('report.period.fiscalYearBegin', fiscalYear.startsAt), g('report.period.fiscalYearEnd', fiscalYear.endsAt), g('report.period.balSheetClosingDate', fiscalYear.endsAt),
    g('report.period.fiscalPreviousYearBegin', gcd.previousPeriod?.start ?? null), g('report.period.fiscalPreviousYearEnd', gcd.previousPeriod?.end ?? null), g('report.period.balSheetClosingDatePreviousYear', gcd.previousPeriod?.end ?? null),
    g('company.id.name', company.companyName), g('company.id.location.street', street), g('company.id.location.houseNo', gcd.houseNumber),
    g('company.id.location.zipCode', company.postalCode), g('company.id.location.city', company.city), g('company.id.location.country', 'Deutschland'),
    choice('company.id.legalStatus', `legalStatus.${company.legalForm}`),
    tuple('company.id.idNo', g('company.id.idNo.type.companyId.ST13', company.taxNumber)
      + g('company.id.idNo.type.companyId.STID', null)
      + nilWithReason('company.id.idNo.type.companyId.STWID', gcd.businessId, 'company.businessId')
      + g('company.id.idNo.type.companyId.BF4', company.taxNumber.slice(0, 4))),
    g('company.id.business', gcd.business), choice('company.id.incomeClassification', 'trade'),
    choice('company.id.entityWithTaxablePurposeBusiness', 'normal'),
    '<de-gcd:genInfo.company.id.domesticBranchOfForeignCompany xsi:nil="true"/>',
    ...gcd.shareholders.map(shareholder => tuple('company.id.shareholder',
      g('company.id.shareholder.name', shareholder.name) + g('company.id.shareholder.id', shareholder.id)
      + nilWithReason('company.id.shareholder.taxnumber', shareholder.taxNumber, `shareholder.${shareholder.id}.taxNumber`)
      + nilWithReason('company.id.shareholder.taxid', shareholder.taxId, `shareholder.${shareholder.id}.taxId`)
      + nilWithReason('company.id.shareholder.WID', shareholder.businessId, `shareholder.${shareholder.id}.businessId`)
      + choice('company.id.shareholder.legalStatus', `legalStatus.${shareholder.legalStatus}`)
      + tuple('company.id.shareholder.ShareDivideKey', g('company.id.shareholder.ShareDivideKey.numerator', String(shareholder.shareNumerator)) + g('company.id.shareholder.ShareDivideKey.denominator', String(shareholder.shareDenominator))))),
  ]
  const facts = dataset.facts.map(fact => item('de-gaap-ci', fact.concept, fact.amountCents === null ? null : centsText(fact.amountCents), fact.context, true))
  const details = dataset.accounts.map(account => `<de-gaap-ci:detailedInformation.accountBalances>${
    item('de-gaap-ci', 'detailedInformation.accountbalances.positionName', `de-gaap-ci:${account.concept}`)
    + item('de-gaap-ci', 'detailedInformation.accountbalances.accountNumber', String(account.number))
    + item('de-gaap-ci', 'detailedInformation.accountbalances.accountDescription', account.name)
    + item('de-gaap-ci', 'detailedInformation.accountbalances.amount', centsText(account.amountCents), 'duration', true)
  }</de-gaap-ci:detailedInformation.accountBalances>`)
  const schema = (entry: string, namespace: string) => remoteSchemas ? `${namespace}/${entry.split('/').at(-1)}` : entry
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xbrli:xbrl xmlns:xbrli="${XMLNS.xbrli}" xmlns:link="${XMLNS.link}" xmlns:xlink="${XMLNS.xlink}" xmlns:xsi="${XMLNS.xsi}" xmlns:xbrldi="${XMLNS.xbrldi}" xmlns:iso4217="http://www.xbrl.org/2003/iso4217" xmlns:de-gaap-ci="${taxonomy.gaapNamespace}" xmlns:de-gcd="${taxonomy.gcdNamespace}">\n${[
    // A non-semantic digest binds identical facts to their exact approval/version.
    // Private evidence remains in the companion JSON, never in taxonomy facts.
    `<!-- dataset-sha256:${eBalanceChecksum(canonicalJson(dataset))} -->`,
    `<link:schemaRef xlink:type="simple" xlink:href="${schema(taxonomy.gcdEntryPoint, taxonomy.gcdNamespace)}"/>`,
    `<link:schemaRef xlink:type="simple" xlink:href="${schema(taxonomy.entryPoint, taxonomy.gaapNamespace)}"/>`,
    ...contexts, '<xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>', ...gcdFacts, ...facts, ...assetFacts, ...details,
  ].join('\n')}\n</xbrli:xbrl>`
}
