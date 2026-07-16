import { AccountingValidationError, type FinancialStatements, type LedgerBalance } from './doubleEntry'

export interface EBalanceCompanyData {
  name: string
  street: string
  postalCode: string
  city: string
  taxNumber: string
  legalForm: EBalanceLegalForm
  fiscalYear: number
  fiscalYearStart: string
  fiscalYearEnd: string
  taxonomyVersion: string
  gaapNamespace: string
  gcdNamespace: string
  entryPoint: string
  gcdEntryPoint: string
  generationDate: string
}

export interface EBalanceMasterData {
  companyName: string
  street: string
  postalCode: string
  city: string
  taxNumber: string
  legalForm: EBalanceLegalForm
}

export const E_BALANCE_LEGAL_FORMS = ['EUN', 'GMBH', 'UG', 'AG'] as const
export type EBalanceLegalForm = typeof E_BALANCE_LEGAL_FORMS[number]

export function parseEBalanceMasterData(body: unknown): EBalanceMasterData {
  if (!body || typeof body !== 'object') throw new AccountingValidationError(['E-Bilanz-Stammdaten fehlen.'])
  const { companyName, street, postalCode, city, taxNumber, legalForm } = body as Record<string, unknown>
  const textValues = [companyName, street, postalCode, city, taxNumber]
  if (textValues.some(value => typeof value !== 'string')) {
    throw new AccountingValidationError(['Firmenname, Straße, PLZ, Ort und Steuernummer müssen Text sein.'])
  }
  if (textValues.some(value => !(value as string).trim())) {
    throw new AccountingValidationError(['Firmenname, Straße, PLZ, Ort und Steuernummer sind erforderlich.'])
  }
  if (typeof legalForm !== 'string' || !E_BALANCE_LEGAL_FORMS.includes(legalForm as EBalanceLegalForm)) {
    throw new AccountingValidationError(['Bitte wählen Sie eine unterstützte Rechtsform.'])
  }
  return { companyName, street, postalCode, city, taxNumber, legalForm: legalForm as EBalanceLegalForm } as EBalanceMasterData
}

export function getEBalanceTaxonomy(year: number) {
  if (year === 2025 || year === 2026) return {
    version: '6.9',
    gaapNamespace: 'http://www.xbrl.de/taxonomies/de-gaap-ci-2025-04-01',
    gcdNamespace: 'http://www.xbrl.de/taxonomies/de-gcd-2025-04-01',
    entryPoint: 'de-gaap-ci-2025-04-01/de-gaap-ci-2025-04-01-shell-fiscal.xsd',
    gcdEntryPoint: 'de-gcd-2025-04-01/de-gcd-2025-04-01-shell.xsd',
  }
  throw new AccountingValidationError([`Für das Wirtschaftsjahr ${year} ist in dieser Version keine freigegebene E-Bilanz-Taxonomie hinterlegt.`])
}

export function createEBalanceXbrl(
  company: EBalanceCompanyData,
  statements: FinancialStatements,
): string {
  const taxNumber = normalizeElsterTaxNumber(company.taxNumber)
  const facts = aggregateFacts(statements.balances)
  const equityFact = facts.get('bs.eqLiab.equity') ?? { cents: 0, instant: true }
  equityFact.cents += statements.netIncomeCents
  facts.set('bs.eqLiab.equity', equityFact)
  facts.set('is.netIncome', { cents: statements.netIncomeCents, instant: false })
  facts.set('bs.ass', { cents: statements.assetsCents, instant: true })
  facts.set('bs.eqLiab', { cents: statements.liabilitiesCents + statements.equityCents, instant: true })
  const factXml = [...facts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([concept, fact]) => `  <de-gaap-ci:${escapeName(concept)} contextRef="${fact.instant ? 'instant' : 'duration'}" unitRef="EUR" decimals="2">${(fact.cents / 100).toFixed(2)}</de-gaap-ci:${escapeName(concept)}>`)
    .join('\n')
  const detailBalances = statements.balances
    .filter(balance => balance.balanceCents !== 0 && balance.eBilanzPosition)
    .map(balance => ({
      number: String(balance.number),
      name: balance.name,
      position: balance.eBilanzPosition!,
      amount: balance.category === 'ASSET' || balance.category === 'EXPENSE'
        ? balance.debitCents - balance.creditCents
        : balance.creditCents - balance.debitCents,
    }))
  if (statements.netIncomeCents !== 0) detailBalances.push({
    number: 'ABSCHLUSS-EK', name: 'Jahresergebnis im Eigenkapital',
    position: 'bs.eqLiab.equity', amount: statements.netIncomeCents,
  })
  if (statements.netIncomeCents !== 0) detailBalances.push({
    number: 'ABSCHLUSS-ERGEBNIS', name: 'Automatisch ermitteltes Jahresergebnis',
    position: 'is.netIncome', amount: statements.netIncomeCents,
  })
  const accountDetailsXml = detailBalances
    .map(detail => {
      return `  <de-gaap-ci:detailedInformation.accountBalances>
    <de-gaap-ci:detailedInformation.accountbalances.positionName contextRef="duration">de-gaap-ci:${escapeName(detail.position)}</de-gaap-ci:detailedInformation.accountbalances.positionName>
    <de-gaap-ci:detailedInformation.accountbalances.accountNumber contextRef="duration">${escapeXml(detail.number)}</de-gaap-ci:detailedInformation.accountbalances.accountNumber>
    <de-gaap-ci:detailedInformation.accountbalances.accountDescription contextRef="duration">${escapeXml(detail.name)}</de-gaap-ci:detailedInformation.accountbalances.accountDescription>
    <de-gaap-ci:detailedInformation.accountbalances.amount contextRef="duration" unitRef="EUR" decimals="2">${(detail.amount / 100).toFixed(2)}</de-gaap-ci:detailedInformation.accountbalances.amount>
  </de-gaap-ci:detailedInformation.accountBalances>`
    }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance"
  xmlns:iso4217="http://www.xbrl.org/2003/iso4217"
  xmlns:link="http://www.xbrl.org/2003/linkbase"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:de-gcd="${escapeXml(company.gcdNamespace)}"
  xmlns:de-gaap-ci="${escapeXml(company.gaapNamespace)}">
  <link:schemaRef xlink:type="simple" xlink:href="${escapeXml(company.gcdEntryPoint)}" />
  <link:schemaRef xlink:type="simple" xlink:href="${escapeXml(company.entryPoint)}" />
  <xbrli:context id="duration">
    <xbrli:entity><xbrli:identifier scheme="http://www.rzf-nrw.de/Steuernummer">${taxNumber}</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:startDate>${escapeXml(company.fiscalYearStart)}</xbrli:startDate><xbrli:endDate>${escapeXml(company.fiscalYearEnd)}</xbrli:endDate></xbrli:period>
  </xbrli:context>
  <xbrli:context id="instant">
    <xbrli:entity><xbrli:identifier scheme="http://www.rzf-nrw.de/Steuernummer">${taxNumber}</xbrli:identifier></xbrli:entity>
    <xbrli:period><xbrli:instant>${escapeXml(company.fiscalYearEnd)}</xbrli:instant></xbrli:period>
  </xbrli:context>
  <xbrli:unit id="EUR"><xbrli:measure>iso4217:EUR</xbrli:measure></xbrli:unit>
  <!-- E-Bilanz-Bericht, Wirtschaftsjahr ${company.fiscalYear}, Taxonomie ${escapeXml(company.taxonomyVersion)} -->
  <de-gcd:genInfo.doc.id.generationDate contextRef="duration">${escapeXml(company.generationDate)}</de-gcd:genInfo.doc.id.generationDate>
  <de-gcd:genInfo.report.id.reportStatus><de-gcd:genInfo.report.id.reportStatus.reportStatus.E contextRef="duration" /></de-gcd:genInfo.report.id.reportStatus>
  <de-gcd:genInfo.report.id.revisionStatus><de-gcd:genInfo.report.id.revisionStatus.revisionStatus.E contextRef="duration" /></de-gcd:genInfo.report.id.revisionStatus>
  <de-gcd:genInfo.report.id.reportElement>
    <de-gcd:genInfo.report.id.reportElement.reportElements.B contextRef="duration" />
    <de-gcd:genInfo.report.id.reportElement.reportElements.BAL xsi:nil="true" contextRef="duration" />
    <de-gcd:genInfo.report.id.reportElement.reportElements.BVV xsi:nil="true" contextRef="duration" />
    <de-gcd:genInfo.report.id.reportElement.reportElements.GuV contextRef="duration" />
    <de-gcd:genInfo.report.id.reportElement.reportElements.KS contextRef="duration" />
  </de-gcd:genInfo.report.id.reportElement>
  <de-gcd:genInfo.report.id.statementType><de-gcd:genInfo.report.id.statementType.statementType.E contextRef="duration" /></de-gcd:genInfo.report.id.statementType>
  <de-gcd:genInfo.report.id.incomeStatementendswithBalProfit contextRef="duration">false</de-gcd:genInfo.report.id.incomeStatementendswithBalProfit>
  <de-gcd:genInfo.report.id.accountingStandard><de-gcd:genInfo.report.id.accountingStandard.accountingStandard.HGB contextRef="duration" /></de-gcd:genInfo.report.id.accountingStandard>
  <de-gcd:genInfo.report.id.incomeStatementFormat><de-gcd:genInfo.report.id.incomeStatementFormat.incomeStatementFormat.GKV contextRef="duration" /></de-gcd:genInfo.report.id.incomeStatementFormat>
  <de-gcd:genInfo.report.id.consolidationRange><de-gcd:genInfo.report.id.consolidationRange.consolidationRange.EA contextRef="duration" /></de-gcd:genInfo.report.id.consolidationRange>
  <de-gcd:genInfo.report.period.fiscalYearBegin contextRef="duration">${escapeXml(company.fiscalYearStart)}</de-gcd:genInfo.report.period.fiscalYearBegin>
  <de-gcd:genInfo.report.period.fiscalYearEnd contextRef="duration">${escapeXml(company.fiscalYearEnd)}</de-gcd:genInfo.report.period.fiscalYearEnd>
  <de-gcd:genInfo.report.period.balSheetClosingDate contextRef="duration">${escapeXml(company.fiscalYearEnd)}</de-gcd:genInfo.report.period.balSheetClosingDate>
  <de-gcd:genInfo.company.id.incomeClassification><de-gcd:genInfo.company.id.incomeClassification.trade contextRef="duration" /></de-gcd:genInfo.company.id.incomeClassification>
  <de-gcd:genInfo.company.id.name contextRef="duration">${escapeXml(company.name)}</de-gcd:genInfo.company.id.name>
  <de-gcd:genInfo.company.id.location contextRef="duration">${escapeXml(company.city)}</de-gcd:genInfo.company.id.location>
  <de-gcd:genInfo.company.id.location.street contextRef="duration">${escapeXml(company.street)}</de-gcd:genInfo.company.id.location.street>
  <de-gcd:genInfo.company.id.location.zipCode contextRef="duration">${escapeXml(company.postalCode)}</de-gcd:genInfo.company.id.location.zipCode>
  <de-gcd:genInfo.company.id.location.city contextRef="duration">${escapeXml(company.city)}</de-gcd:genInfo.company.id.location.city>
  <de-gcd:genInfo.company.id.legalStatus><de-gcd:genInfo.company.id.legalStatus.legalStatus.${company.legalForm} contextRef="duration" /></de-gcd:genInfo.company.id.legalStatus>
  <de-gcd:genInfo.company.id.idNo><de-gcd:genInfo.company.id.idNo.type.companyId.ST13 contextRef="duration">${taxNumber}</de-gcd:genInfo.company.id.idNo.type.companyId.ST13></de-gcd:genInfo.company.id.idNo>
${factXml}
${accountDetailsXml}
</xbrli:xbrl>`
}

export function normalizeElsterTaxNumber(value: string): string {
  const normalized = value.replace(/[\s/-]/g, '')
  if (!/^\d{13}$/.test(normalized)) {
    throw new AccountingValidationError(['Die ELSTER-Steuernummer muss aus genau 13 Ziffern bestehen.'])
  }
  return normalized
}

function aggregateFacts(balances: LedgerBalance[]): Map<string, { cents: number; instant: boolean }> {
  const facts = new Map<string, { cents: number; instant: boolean }>()
  for (const balance of balances) {
    if (!balance.eBilanzPosition || balance.balanceCents === 0) continue
    const amount = balance.category === 'ASSET' || balance.category === 'EXPENSE'
      ? balance.debitCents - balance.creditCents
      : balance.creditCents - balance.debitCents
    const existing = facts.get(balance.eBilanzPosition)
    const instant = balance.category === 'ASSET' || balance.category === 'LIABILITY' || balance.category === 'EQUITY'
    facts.set(balance.eBilanzPosition, { cents: (existing?.cents ?? 0) + amount, instant })
  }
  return facts
}

function escapeXml(value: string): string {
  for (const character of value) {
    const point = character.codePointAt(0)!
    const allowed = point === 0x9 || point === 0xA || point === 0xD ||
      (point >= 0x20 && point <= 0xD7FF) || (point >= 0xE000 && point <= 0xFFFD) ||
      (point >= 0x10000 && point <= 0x10FFFF)
    if (!allowed) throw new AccountingValidationError(['E-Bilanz-Stammdaten enthalten ein in XML nicht zulässiges Zeichen.'])
  }
  return value.replace(/[<>&"']/g, character => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[character]!)
}

function escapeName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value)) {
    throw new Error(`Ungültiger Taxonomie-Bezeichner: ${value}`)
  }
  return value
}
