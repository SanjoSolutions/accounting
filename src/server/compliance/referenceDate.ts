export function complianceReferenceDate(env: Readonly<Record<string, string | undefined>> = process.env, systemDate = new Date().toISOString().slice(0, 10)) {
  const override = env.COMPLIANCE_E2E_REFERENCE_DATE?.trim()
  if (!override) return systemDate
  if (env.NODE_ENV === 'production') throw new Error('COMPLIANCE_E2E_REFERENCE_DATE is forbidden in production.')
  const parsed = new Date(`${override}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(override) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== override) throw new Error('COMPLIANCE_E2E_REFERENCE_DATE must be a real ISO calendar date.')
  return override
}
