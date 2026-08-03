import 'server-only'

import { getCurrentUser } from '@/server/authentication'
import { authorizeComplianceTenant, complianceError } from '@/server/compliance/runtime'
import { listHgbWorkpapers, saveHgbWorkpaper } from '@/server/hgbWorkpaperRepository'
import type { HgbWorkpaperDraft } from '@/core/hgbWorkpapers'

const yearFrom = async (params: Promise<{ year: string }>) => { const year = Number((await params).year); if (!Number.isSafeInteger(year)) throw new TypeError('Fiscal year must be an integer'); return year }

export async function GET(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  try { const url = new URL(request.url); const ownerId = await authorizeComplianceTenant(user.id, url.searchParams.get('tenantId')); return Response.json({ success: true, data: await listHgbWorkpapers(ownerId, await yearFrom(params)) }) } catch (error) { return complianceError(error) }
}

export async function PUT(request: Request, { params }: { params: Promise<{ year: string }> }) {
  const user = await getCurrentUser(request.headers); if (!user) return Response.json({ success: false }, { status: 401 })
  try {
    const value: unknown = await request.json(); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Workpaper request must be an object')
    const body = value as Record<string, unknown>; const ownerId = await authorizeComplianceTenant(user.id, body.tenantId)
    return Response.json({ success: true, data: await saveHgbWorkpaper(ownerId, user.id, await yearFrom(params), body.workpaper as HgbWorkpaperDraft, typeof body.expectedChecksum === 'string' ? body.expectedChecksum : undefined) })
  } catch (error) { return complianceError(error) }
}
