import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'

const messages = {
  en: JSON.parse(readFileSync('messages/en.json', 'utf8')) as Record<string, any>,
  de: JSON.parse(readFileSync('messages/de.json', 'utf8')) as Record<string, any>,
}

describe('localized copy clusters', () => {
  test('uses singular and plural close-blocker grammar in both locales', () => {
    expect(messages.en.Workspaces.closeBlockers).toContain('one {{countFormatted} blocker prevents closing}')
    expect(messages.en.Workspaces.closeBlockers).toContain('other {{countFormatted} blockers prevent closing}')
    expect(messages.de.Workspaces.closeBlockers).toContain('one {{countFormatted} Blocker verhindert den Abschluss}')
    expect(messages.de.Workspaces.closeBlockers).toContain('other {{countFormatted} Blocker verhindern den Abschluss}')
    expect(messages.en.Workspaces.closeBlockers).toContain('{count, plural,')
    expect(messages.de.Workspaces.closeBlockers).toContain('{count, plural,')
  })

  test('provides localized HGB schema enum and run-status labels while preserving technical codes', () => {
    expect(messages.en.HgbCloseWorkbench.enum.UNKNOWN).toBe('Unknown')
    expect(messages.en.HgbCloseWorkbench.enum.APPLICABLE).toBe('Applicable')
    expect(messages.en.HgbCloseWorkbench.status.READY_TO_LOCK).toBe('Ready to lock')
    expect(messages.de.HgbCloseWorkbench.enum.UNKNOWN).toBe('Unbekannt')
    expect(messages.de.HgbCloseWorkbench.enum.APPLICABLE).toBe('Anwendbar')
    expect(messages.de.HgbCloseWorkbench.status.READY_TO_LOCK).toBe('Zur Festschreibung bereit')
  })

  test('keeps annual-accounts adoption and shareholder-resolution wording explicit', () => {
    expect(messages.en.Workspaces.hgbWorkpapers).toContain('annual-accounts adoption')
    expect(messages.en.Workspaces.hgbEvidencePending).toContain('shareholder resolution')
    expect(messages.de.Workspaces.hgbWorkpapers).toContain('Feststellung des Jahresabschlusses')
    expect(messages.de.Workspaces.hgbEvidencePending).toContain('Gesellschafterbeschluss')
  })

  test('uses precise report, fixed-asset, settings and commercial labels', () => {
    expect(messages.en.AccountingReports.lastBookingDate).toBe('Last posting date')
    expect(messages.en.AccountingReports.searchAccounts).toBe('Search accounts')
    expect(messages.en.FixedAssets.soldGain).toContain('resulting in a book gain of')
    expect(messages.en.FixedAssets.soldLoss).toContain('resulting in a book loss of')
    expect(messages.en.FixedAssets.retired).toContain('a carrying amount of')
    expect(messages.de.FixedAssets.retired).toContain('ein Restbuchwert von')
    expect(messages.en.Settings['Contact telephone']).toBe('Phone for invoice questions')
    expect(messages.en.Settings['Contact email']).toBe('Email for invoice questions')
    expect(messages.en.Settings.City).toBe('Town')
    expect(messages.de.Settings.City).toBe('Ort')
    expect(messages.en.Commercial.paymentTerm).toBe('Payment term')
    expect(messages.de.Commercial.paymentTerm).toBe('Zahlungsziel')
  })

  test('does not encode layout whitespace in booking-batch hints', () => {
    expect(messages.en.BookingBatches.documentsHint).not.toMatch(/^\s/)
    expect(messages.de.BookingBatches.documentsHint).not.toMatch(/^\s/)
    expect(messages.en.BookingBatches.postReasonHint).not.toMatch(/^\s/)
    expect(messages.de.BookingBatches.postReasonHint).not.toMatch(/^\s/)
  })
})
