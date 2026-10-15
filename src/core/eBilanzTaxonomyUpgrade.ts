import type { EBalanceExportDataset } from './eBilanzExport'
import { monetaryConcept, type EBalanceTaxonomyModel } from './eBilanzTaxonomyModel'

/** A review plan only. Upgrading always regenerates and revalidates a new dataset;
 * it never rewrites an accepted instance or silently remaps a removed concept. */
export function planEBalanceTaxonomyUpgrade(dataset: EBalanceExportDataset, source: EBalanceTaxonomyModel, target: EBalanceTaxonomyModel) {
  if (dataset.taxonomy.archiveSha256 !== source.release.archiveSha256 || dataset.taxonomy.version !== source.release.version) throw new Error('Upgrade source differs from the retained taxonomy.')
  const parts = (version: string) => version.split('.').map(Number)
  const [fromMajor, fromMinor] = parts(source.release.version)
  const [toMajor, toMinor] = parts(target.release.version)
  if (toMajor < fromMajor || (toMajor === fromMajor && toMinor <= fromMinor)) throw new Error('Upgrade target must be a later taxonomy.')
  if (dataset.fiscalYear.startsAt < target.release.validFrom || dataset.fiscalYear.startsAt > target.release.validThrough) throw new Error('Upgrade target is not applicable to this fiscal period.')
  const blockers: Array<{ accountId: string; concept: string; reason: string }> = []
  for (const account of dataset.accounts) {
    try {
      const before = monetaryConcept(source, account.concept)
      const after = monetaryConcept(target, account.concept)
      if (before.period !== after.period || before.balance !== after.balance || before.type !== after.type) throw new Error('Concept type, period or balance changed.')
    } catch (error) { blockers.push({ accountId: account.accountId, concept: account.concept, reason: String(error) }) }
  }
  const newlyRequiredConcepts = [...target.concepts].filter(([key, concept]) => concept.required && !concept.abstract && !source.concepts.get(key)?.required).map(([key]) => key).sort()
  const calculationChanges = [...new Set([...source.calculations.keys(), ...target.calculations.keys()])].filter(key =>
    JSON.stringify(source.calculations.get(key)) !== JSON.stringify(target.calculations.get(key))).sort()
  return { fromVersion: source.release.version, toVersion: target.release.version,
    sourceArchiveSha256: source.release.archiveSha256, targetArchiveSha256: target.release.archiveSha256,
    blockers, newlyRequiredConcepts, calculationChanges, requiresNewValidation: true as const,
    receiverVerifiedOn: target.release.receiverVerifiedOn, officialAcceptance: 'NOT_VALIDATED' as const }
}
