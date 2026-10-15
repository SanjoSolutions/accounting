import { declarationDatasetHash, taxFormRegistry, type DeclarationKind } from '../core/taxDeclarations'
import { qualifiedContractFormVersions } from '../server/tax/qualificationContract'

// Unit-test-only artifacts; these never constitute qualification evidence.
export function qualificationFixtureBundle() {
  return {
    schema: 'qualified-tax-gateway-artifacts', version: 1, environment: 'STAGING',
    artifacts: qualifiedContractFormVersions.map(formVersion => {
      const [kind, version] = formVersion.split('-')
      const year = version.slice(0, 4)
      const fields: Record<string, number | string> = kind === 'USTVA' || kind === 'UST_ANNUAL' ? { ZAHLLAST: 1900 }
        : kind === 'KST' ? { STEUERLICHES_ERGEBNIS: 100000, KST_SCHULD: 15000 }
          : { GEWERBEERTRAG: 100000, GEMEINDE: '11000000', HEBESATZ_BP: 41000, GEWST_SCHULD: 14350 }
      const dataset = taxFormRegistry.prepare(kind as DeclarationKind, kind === 'USTVA' ? `${year}-01` : year, fields, {}, 'synthetic-authorized-taxpayer')
      return { preparationId: `synthetic-preparation-${formVersion}`, datasetSha256: declarationDatasetHash(dataset), dataset }
    }),
  }
}
