import { test } from '@playwright/test'
import { DocumentExtractionPage } from './document-extraction-page'
import { SettingsPage } from './pages'

const reverseChargeUbl = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID><cbc:ID>UBL-RC-E2E</cbc:ID><cbc:IssueDate>2026-07-26</cbc:IssueDate><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cac:Delivery><cbc:ActualDeliveryDate>2026-07-26</cbc:ActualDeliveryDate></cac:Delivery>
<cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>German Construction Supplier GmbH</cbc:Name></cac:PartyName><cac:PostalAddress><cbc:StreetName>Markt 1</cbc:StreetName><cbc:CityName>Berlin</cbc:CityName><cbc:PostalZone>10115</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>DE123456789</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Buyer GmbH</cbc:Name></cac:PartyName><cac:PostalAddress><cbc:StreetName>Ring 2</cbc:StreetName><cbc:CityName>Berlin</cbc:CityName><cbc:PostalZone>10117</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>DE987654321</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme></cac:Party></cac:AccountingCustomerParty>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>AE</cbc:ID><cbc:Percent>0</cbc:Percent><cbc:TaxExemptionReason>Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG</cbc:TaxExemptionReason><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">100.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">100.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cac:Item><cbc:Description>Domestic construction service</cbc:Description><cac:ClassifiedTaxCategory><cbc:ID>AE</cbc:ID><cbc:Percent>0</cbc:Percent><cbc:TaxExemptionReason>Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG</cbc:TaxExemptionReason><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item></cac:InvoiceLine>
</Invoice>`)

test.describe('real domestic §13b supplier payable journey', () => {
  test('Given explicitly configured SKR03 controls and a genuine UBL AE invoice, when 19% recipient tax is confirmed, then the net payable and balanced canonical VAT evidence survive reload', async ({ page }) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const invoice = new DocumentExtractionPage(page)
    await invoice.signUp(`Reverse charge ${unique}`, `reverse-charge-${unique}@example.test`, 'playwright-password-2026')
    await new SettingsPage(page).configureDomesticReverseCharge('SKR03', '1577', '1787')
    await invoice.uploadReviewAndPostReverseChargeUbl(reverseChargeUbl)
    await invoice.proveReverseChargePayableAfterReload()
  })
})
