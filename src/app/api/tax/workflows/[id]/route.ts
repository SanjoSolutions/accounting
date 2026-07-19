import 'server-only'
import { TaxDeclarationError } from '@/core/taxDeclarations'
import { getCurrentUser } from '@/server/authentication'
import { cancelTaxWorkflow, correctTaxWorkflow, recoverTaxWorkflow, type DatasetInput } from '@/server/tax/workflows'
import { requireTaxJsonObject, taxError } from '@/server/tax/http'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const id = (await params).id
    const body = requireTaxJsonObject(await request.json(), 'Tax workflow action') as { action?: 'correct' | 'cancel' | 'recover'; confirmed?: boolean; requestKey?: string; dataset?: DatasetInput }
    if (body.confirmed !== true) throw new TaxDeclarationError(['Explicit approval is required for this official action.'])
    if (body.action === 'cancel') return Response.json({ success: true, data: await cancelTaxWorkflow(user.id, user.id, id) })
    if (body.action === 'recover') return Response.json({ success: true, data: await recoverTaxWorkflow(user.id, id) })
    if (body.action === 'correct' && body.dataset && typeof body.requestKey === 'string') { const dataset: DatasetInput = { kind: body.dataset.kind, period: body.dataset.period, fields: body.dataset.fields, ...(body.dataset.drilldown ? { drilldown: body.dataset.drilldown } : {}) }; return Response.json({ success: true, data: await correctTaxWorkflow(user.id, user.id, id, body.requestKey, dataset) }, { status: 201 }) }
    throw new TaxDeclarationError(['A supported correction, cancellation or recovery action is required.'])
  } catch (error) { return taxError(error) }
}
