import type { EBalanceExportDataset } from './eBilanzExport'
import { E_BALANCE_ATTACHMENT_CONCEPTS } from './eBilanzReportScope'
import { centsText, xmlEscape } from './eBilanzXml'

export function eBalanceFilingAttachments(dataset: EBalanceExportDataset) {
  const attachments = (dataset.reconciliation.payload.attachments ?? []).flatMap(row => row.status === 'PRESENT'
    ? [{ ...E_BALANCE_ATTACHMENT_CONCEPTS[row.kind], text: row.text }] : [])
  if (dataset.reconciliation.payload.schemaVersion === 'EBILANZ_TAX_BALANCE_V2' && dataset.assets.length) {
    attachments.push({ concept: 'nt.reg', reportElement: 'AV', text: dataset.assets.map(asset => [
      `Anlage: ${asset.book.assetId} - ${asset.book.description}`,
      `Anschaffung: ${asset.acquisitionDate}; Standort: ${asset.book.location}`,
      `Konto: ${asset.accountId}; Taxonomieposition: ${asset.concept}`,
      `Anschaffungs-/Herstellungskosten (EUR): ${centsText(asset.tax.closingCostCents)}`,
      `Abschreibungen kumuliert (EUR): ${centsText(asset.tax.closingAccumulatedDepreciationCents)}`,
      `Abschreibungen Wirtschaftsjahr (EUR): ${centsText(asset.tax.currentDepreciationCents)}`,
      `Buchwert steuerlich (EUR): ${centsText(asset.tax.carryingAmountCents)}`,
      `Buchwert handelsrechtlich (EUR): ${centsText(asset.book.carryingAmountCents)}`,
    ].join('\n')).join('\n\n') })
  }
  return attachments
}

/** Official string concepts carry the plain-text document in an XBRL footnote.
 * Evidence IDs stay in the retained dataset, not in the filing document. */
export function serializeEBalanceAttachments(attachments: ReturnType<typeof eBalanceFilingAttachments>) {
  return attachments.map((attachment, index) => {
    const id = `attachment-${index}`
    return `<de-gaap-ci:${attachment.concept} id="${id}" contextRef="duration"></de-gaap-ci:${attachment.concept}>\n`
      + `<link:footnoteLink xlink:type="extended" xlink:role="http://www.xbrl.org/2003/role/link">`
      + `<link:loc xlink:type="locator" xlink:href="#${id}" xlink:label="fact"/>`
      + `<link:footnote xlink:type="resource" xlink:label="note" xlink:role="http://www.xbrl.org/2003/role/footnote" xml:lang="de">${xmlEscape(attachment.text)}</link:footnote>`
      + `<link:footnoteArc xlink:type="arc" xlink:arcrole="http://www.xbrl.org/2003/arcrole/fact-footnote" xlink:from="fact" xlink:to="note"/>`
      + `</link:footnoteLink>`
  }).join('\n')
}
