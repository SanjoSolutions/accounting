import 'server-only'

import { getCurrentUser } from '@/server/authentication'

/** Exposes capability only; never endpoints, credentials, or qualification claims. */
export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const endpoint = process.env.TAX_GATEWAY_URL
  const local = Boolean(endpoint && /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/.test(endpoint))
  return Response.json({ success: true, data: {
    configured: Boolean(endpoint && process.env.TAX_GATEWAY_CREDENTIAL?.trim()),
    mode: local ? 'LOCAL_LIFECYCLE_EMULATOR' : endpoint ? 'CONFIGURED_EXTERNAL_GATEWAY' : 'NOT_CONFIGURED',
    officialQualificationRequired: true,
  } })
}
