import golden from '@/core/compliance/fixtures/hgb-annual-golden.json'
import { prepareAnnualAccounts, type AnnualPackageInput } from '@/core/compliance/annualAccounts'
import type { AnnualDocumentSource } from '@/core/compliance/annualDocuments'

export function annualDocumentFixture(size: 'SMALL' | 'MICRO' = 'SMALL'): AnnualDocumentSource {
  const input = structuredClone(golden) as AnnualPackageInput
  input.profile = { ...input.profile, tenantId: 'tenant-a', legalForm: 'UG', size, legalName: 'Druck & Daten UG (haftungsbeschränkt)' }
  input.notes = ['Haftungsverhältnisse nach § 268 Abs. 7 HGB bestehen nicht.', 'Vorschüsse oder Kredite an Mitglieder der Geschäftsführung bestehen nicht.', 'PRIVATE GuV: Einzelkunde Geheimkunde']
  input.policies = ['Bewertung zu Anschaffungskosten.', 'PRIVATE policy workpaper']
  return {
    packageId: 'annual-a', packageVersion: 1, packageChecksum: 'a'.repeat(64), input, annual: prepareAnnualAccounts(input, 1),
    approvedBy: 'reviewer-a', approvedAt: '2027-03-02T12:00:00Z',
    close: { id: 'close-a', checksum: 'b'.repeat(64), notesRequired: size === 'SMALL', signatures: [{ representativeId: 'Geschäftsführer Test', signedAt: '2027-03-02T12:00:00Z', signatureEvidenceId: 'private-signature' }], resolutionId: 'private-resolution' },
    equity: { resultCents: 30000, shareCapitalCents: 100000, section5aReserveApplicable: true, reserveCalculationEvidenceId: 'private-reserve', evidenceId: 'private-equity' },
  }
}
