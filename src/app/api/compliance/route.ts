import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import {
  authorizeComplianceTenant, complianceError, configureCompliancePolicy, confirmHistoricalProfileAddress, correctPostedEntry, createDraft, createFilingAmendment,
  createFiscalPeriod, createTenantBackup, decidePeriodReopen, disposeArtifact, getComplianceOverview,
  mappingAuditExport, placeLegalHold, postDraft, reconcileDocumentArtifacts, requestPeriodReopen, resolveMappings, reviseDraft,
  runDueFixityChecks, runFixityCheck, verifyTenantRestore,
} from '@/server/compliance/runtime'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  const url = new URL(request.url)
  try {
    const ownerId = await authorizeComplianceTenant(user.id, url.searchParams.get('tenantId'))
    if (url.searchParams.get('view') === 'mappings') {
      const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10)
      return Response.json({ success: true, data: await resolveMappings(ownerId, date) })
    }
    if (url.searchParams.get('view') === 'mapping-audit') return Response.json({ success: true, data: await mappingAuditExport(ownerId) })
    const at = url.searchParams.get('at')
    return Response.json({ success: true, data: await getComplianceOverview(ownerId, at ? new Date(at) : new Date()) })
  } catch (error) { return complianceError(error) }
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const parsed: unknown = await request.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Response.json({ success: false, error: 'Compliance request body must be an object' }, { status: 400 })
    const body = parsed as Record<string, unknown>
    const ownerId = await authorizeComplianceTenant(user.id, body.tenantId)
    let data: unknown
    switch (body.action) {
      case 'period.create': data = await createFiscalPeriod(ownerId, user.id, body); break
      case 'draft.create': data = await createDraft(ownerId, user.id, body); break
      case 'draft.revise': data = await reviseDraft(ownerId, user.id, String(body.draftId ?? ''), body); break
      case 'draft.post': data = await postDraft(ownerId, user.id, String(body.draftId ?? ''), body.reason); break
      case 'entry.correct': data = await correctPostedEntry(ownerId, user.id, String(body.entryId ?? ''), body); break
      case 'period.reopen.request': data = await requestPeriodReopen(ownerId, user.id, String(body.periodId ?? ''), body.reason); break
      case 'period.reopen.decide': {
        if (typeof body.approve !== 'boolean') return Response.json({ success: false, error: 'approve must be a boolean' }, { status: 400 })
        data = await decidePeriodReopen(ownerId, user.id, String(body.requestId ?? ''), body.approve, body.reason)
        break
      }
      case 'filing.amend': data = await createFilingAmendment(ownerId, user.id, body); break
      case 'profile.address-confirm': data = await confirmHistoricalProfileAddress(ownerId, user.id, String(body.profileVersionId ?? ''), body.address, body.reason); break
      case 'policy.configure': data = await configureCompliancePolicy(ownerId, user.id, body); break
      case 'retention.hold': data = await placeLegalHold(ownerId, user.id, String(body.artifactId ?? ''), String(body.until ?? ''), body.reason); break
      case 'retention.reconcile': data = await reconcileDocumentArtifacts(ownerId, user.id, body.reason); break
      case 'retention.fixity': data = await runFixityCheck(ownerId, user.id, String(body.artifactId ?? ''), body.reason); break
      case 'retention.fixity-scan': data = await runDueFixityChecks(ownerId, user.id, String(body.before ?? ''), body.reason); break
      case 'retention.dispose': data = await disposeArtifact(ownerId, user.id, String(body.artifactId ?? ''), String(body.onDate ?? ''), body.reason); break
      case 'backup.create': data = await createTenantBackup(ownerId, user.id, String(body.region ?? ''), body.reason); break
      case 'backup.verify-restore': {
        if (typeof body.measuredRestoreMinutes !== 'number' || !Number.isFinite(body.measuredRestoreMinutes)) return Response.json({ success: false, error: 'measuredRestoreMinutes must be a finite number' }, { status: 400 })
        data = await verifyTenantRestore(ownerId, user.id, String(body.backupId ?? ''), body.measuredRestoreMinutes, body.reason)
        break
      }
      default: return Response.json({ success: false, error: 'Unsupported compliance action' }, { status: 400 })
    }
    return Response.json({ success: true, data }, { status: 201 })
  } catch (error) { return complianceError(error) }
}
