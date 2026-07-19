import 'server-only'
import { TaxDeclarationError } from '@/core/taxDeclarations'
import { getCurrentUser } from '@/server/authentication'
import { listTaxWorkflows, submitTaxDataset, validateTaxDataset, type DatasetInput } from '@/server/tax/workflows'
import { requireTaxJsonObject, taxError } from '@/server/tax/http'

export async function GET(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  return Response.json({ success: true, data: await listTaxWorkflows(user.id) })
}

export async function POST(request: Request) {
  const user = await getCurrentUser(request.headers)
  if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const body = requireTaxJsonObject(await request.json(), 'Tax workflow request') as { action?: 'validate' | 'submit'; confirmed?: boolean; requestKey?: string; dataset?: DatasetInput }
    if (!body.dataset) throw new TaxDeclarationError(['A declaration dataset is required.'])
    const dataset: DatasetInput = { kind: body.dataset.kind, period: body.dataset.period, fields: body.dataset.fields, ...(body.dataset.drilldown ? { drilldown: body.dataset.drilldown } : {}) }
    if (body.action === 'validate') return Response.json({ success: true, data: await validateTaxDataset(user.id, dataset) })
    if (body.action !== 'submit' || body.confirmed !== true) throw new TaxDeclarationError(['Explicit approval is required before a binding transmission.'])
    if (typeof body.requestKey !== 'string') throw new TaxDeclarationError(['A request key is required.'])
    return Response.json({ success: true, data: await submitTaxDataset(user.id, user.id, body.requestKey, dataset) }, { status: 201 })
  } catch (error) { return taxError(error) }
}
