import 'server-only'

import { validateCompanyProfile, type CompanyProfile } from '@/server/compliance/companyProfile'
import { TaxDeclarationError } from '@/core/taxDeclarations'
import { prisma } from '@/server/persistence/client'

type StoredProfileVersion = { effectiveFrom: Date; effectiveTo: Date | null; payload: string }

export function selectProfileVersionForPeriod(versions: readonly StoredProfileVersion[], startsAt: Date, endsAt: Date): CompanyProfile {
  const start = startsAt.toISOString().slice(0, 10); const end = endsAt.toISOString().slice(0, 10)
  const date = (value: Date) => value.toISOString().slice(0, 10)
  const covering = versions.filter(version => date(version.effectiveFrom) <= start && (!version.effectiveTo || date(version.effectiveTo) >= end)).sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0]
  if (!covering) throw new TaxDeclarationError(['A canonical company-profile version covering the complete filing period is required.'])
  const transition = versions.some(version => date(version.effectiveFrom) > date(covering.effectiveFrom) && date(version.effectiveFrom) <= end)
  if (transition) throw new TaxDeclarationError(['Company-profile transitions inside a filing period must be resolved before binding tax preparation.'])
  let profile: unknown
  try { profile = JSON.parse(covering.payload) } catch { throw new TaxDeclarationError(['The effective company-profile version is invalid.']) }
  const issues = validateCompanyProfile(profile)
  if (issues.length) throw new TaxDeclarationError(issues.map(issue => `Effective company profile: ${issue}`))
  return profile as CompanyProfile
}

export async function companyProfileForPeriod(ownerId: string, startsAt: Date, endsAt: Date) {
  const versions = await prisma.companyProfileVersion.findMany({ where: { ownerId, effectiveFrom: { lte: endsAt } }, orderBy: { effectiveFrom: 'desc' }, select: { effectiveFrom: true, effectiveTo: true, payload: true } })
  return selectProfileVersionForPeriod(versions, startsAt, endsAt)
}
