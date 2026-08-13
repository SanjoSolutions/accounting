import 'server-only'

import { profilesSemanticallyEqual, validateCompanyProfile, type CompanyProfile } from '@/server/compliance/companyProfile'
import { TaxDeclarationError } from '@/core/taxDeclarations'
import { prisma } from '@/server/persistence/client'

type StoredProfileVersion = { effectiveFrom: Date; effectiveTo: Date | null; payload: string }

export function selectProfileVersionForPeriod(versions: readonly StoredProfileVersion[], startsAt: Date, endsAt: Date): CompanyProfile {
  const start = startsAt.toISOString().slice(0, 10); const end = endsAt.toISOString().slice(0, 10)
  const date = (value: Date) => value.toISOString().slice(0, 10)
  const covering = versions.filter(version => date(version.effectiveFrom) <= start && (!version.effectiveTo || date(version.effectiveTo) >= end)).sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0]
  if (!covering) throw new TaxDeclarationError(['A canonical company-profile version covering the complete filing period is required.'])
  let coveringProfile: unknown
  try { coveringProfile = JSON.parse(covering.payload) } catch { throw new TaxDeclarationError(['The effective company-profile version is invalid.']) }
  const transition = versions.some(version => {
    if (date(version.effectiveFrom) <= date(covering.effectiveFrom) || date(version.effectiveFrom) > end) return false
    try { return !profilesSemanticallyEqual(JSON.parse(version.payload), coveringProfile) } catch { return true }
  })
  if (transition) throw new TaxDeclarationError(['Company-profile transitions inside a filing period must be resolved before binding tax preparation.'])
  const issues = validateCompanyProfile(coveringProfile)
  if (issues.length) throw new TaxDeclarationError(issues.map(issue => `Effective company profile: ${issue}`))
  return coveringProfile as CompanyProfile
}

export async function companyProfileForPeriod(ownerId: string, startsAt: Date, endsAt: Date) {
  const versions = await prisma.companyProfileVersion.findMany({ where: { ownerId, effectiveFrom: { lte: endsAt } }, orderBy: { effectiveFrom: 'desc' }, select: { effectiveFrom: true, effectiveTo: true, payload: true } })
  return selectProfileVersionForPeriod(versions, startsAt, endsAt)
}
