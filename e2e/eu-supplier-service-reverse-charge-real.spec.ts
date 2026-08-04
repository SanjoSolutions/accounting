import { test } from '@playwright/test'
import { DocumentExtractionPage } from './document-extraction-page'
import { SettingsPage } from './pages'

const euServiceUbl = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
<cbc:CustomizationID>urn:cen.eu:en16931:2017</cbc:CustomizationID><cbc:ID>EU-SVC-AT-E2E</cbc:ID><cbc:IssueDate>2026-07-26</cbc:IssueDate><cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode><cac:Delivery><cbc:ActualDeliveryDate>2026-08-01</cbc:ActualDeliveryDate></cac:Delivery>
<cac:AccountingSupplierParty><cac:Party><cac:PartyName><cbc:Name>Vienna Cloud GmbH</cbc:Name></cac:PartyName><cac:PostalAddress><cbc:StreetName>Ring 1</cbc:StreetName><cbc:CityName>Wien</cbc:CityName><cbc:PostalZone>1010</cbc:PostalZone><cac:Country><cbc:IdentificationCode>AT</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>ATU12345678</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme></cac:Party></cac:AccountingSupplierParty>
<cac:AccountingCustomerParty><cac:Party><cac:PartyName><cbc:Name>Buyer GmbH</cbc:Name></cac:PartyName><cac:PostalAddress><cbc:StreetName>Ring 2</cbc:StreetName><cbc:CityName>Berlin</cbc:CityName><cbc:PostalZone>10117</cbc:PostalZone><cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country></cac:PostalAddress><cac:PartyTaxScheme><cbc:CompanyID>DE987654321</cbc:CompanyID><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme></cac:Party></cac:AccountingCustomerParty>
<cac:TaxTotal><cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="EUR">100.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="EUR">0.00</cbc:TaxAmount><cac:TaxCategory><cbc:ID>AE</cbc:ID><cbc:Percent>0</cbc:Percent><cbc:TaxExemptionReason>Reverse charge - Article 196 VAT Directive</cbc:TaxExemptionReason><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
<cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cbc:TaxExclusiveAmount currencyID="EUR">100.00</cbc:TaxExclusiveAmount><cbc:TaxInclusiveAmount currencyID="EUR">100.00</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="EUR">100.00</cbc:PayableAmount></cac:LegalMonetaryTotal>
<cac:InvoiceLine><cbc:ID>1</cbc:ID><cbc:InvoicedQuantity unitCode="C62">1</cbc:InvoicedQuantity><cbc:LineExtensionAmount currencyID="EUR">100.00</cbc:LineExtensionAmount><cac:Item><cbc:Description>Cloud service</cbc:Description><cac:ClassifiedTaxCategory><cbc:ID>AE</cbc:ID><cbc:Percent>0</cbc:Percent><cbc:TaxExemptionReason>Reverse charge - Article 196 VAT Directive</cbc:TaxExemptionReason><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory></cac:Item></cac:InvoiceLine>
</Invoice>`)

test.describe('real EU supplier B2B service reverse-charge journey', () => {
  test('Given an Austrian AE service invoice and explicit SKR03 controls, when 19% is confirmed, then net payable and KZ 46/47/67 canonical VAT evidence survive reload', async ({ page }) => {
    const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`
    const invoice = new DocumentExtractionPage(page)
    await invoice.signUp(`EU service ${unique}`, `eu-service-${unique}@example.test`, 'playwright-password-2026')
    await new SettingsPage(page).configureDomesticReverseCharge('SKR03', '1577', '1787', 'DE987654321')
    await invoice.uploadReviewAndPostEuServiceReverseChargeUbl(euServiceUbl)
    await invoice.proveEuServiceReverseChargeAfterReload()
  })
})
