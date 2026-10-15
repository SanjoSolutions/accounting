import 'server-only'
import { prisma } from '@/server/persistence/client'
import { selectProfileVersionForPeriod } from './profileRepository'
import { VatValidationError } from '@/core/vatEngine'
import type { CompanyVatRegime } from '@/core/smallBusinessVat'

type ProfileReader = Pick<typeof prisma, 'companyProfileVersion' | 'accountRecord'>

/** Never use today's small-business status for an earlier, uncovered transaction. */
export async function companyVatRegimeAt(ownerId: string, date: string, reader: ProfileReader = prisma): Promise<CompanyVatRegime> {
  const instant = new Date(`${date}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(instant.valueOf()) || instant.toISOString().slice(0, 10) !== date) throw new VatValidationError(['A real VAT effective date is required.'])
  const versions = await reader.companyProfileVersion.findMany({ where: { ownerId }, orderBy: { effectiveFrom: 'desc' }, select: { effectiveFrom: true, effectiveTo: true, payload: true } })
  if (versions.length) {
    const profile = selectProfileVersionForPeriod(versions, instant, instant)
    if (profile.vatRegime === 'SMALL_BUSINESS' && profile.registeredAddress && profile.registeredAddress.country.toUpperCase() !== 'DE') throw new VatValidationError(['The domestic Kleinunternehmer workflow requires a German company profile. The cross-border §19a scheme is not supported.'])
    return profile.vatRegime
  }
  const account = await reader.accountRecord.findUnique({ where: { ownerId }, select: { payload: true } })
  const regime = account ? JSON.parse(account.payload).companyProfile?.vatRegime : undefined
  if (regime === 'SMALL_BUSINESS') throw new VatValidationError(['Confirm the effective date of the Kleinunternehmer company profile before posting.'])
  // Preserve the pre-profile standard-tax workflow for legacy tenants.
  return regime === 'EXEMPT' ? 'EXEMPT' : 'STANDARD'
}
