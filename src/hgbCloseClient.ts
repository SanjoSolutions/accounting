import type { HgbCloseReadinessInput, HgbWorkpaperKind } from './core/hgbClose'
import type { HgbWorkpaperDraft, HgbWorkpaperStatus } from './core/hgbWorkpapers'

export interface HgbWorkpaperRecordView {
  id: string
  kind: HgbWorkpaperKind
  version: number
  status: HgbWorkpaperStatus
  checksum: string
  payload: HgbWorkpaperDraft
  preparedBy?: string | null
  reviewedBy?: string | null
  reviewReason?: string | null
  adjustments: Array<{ id: string; proposalId: string; status: string; postedEntryId?: string | null }>
}

export interface HgbWorkpaperCollection {
  fiscalPeriod: { id: string; year: number; startsAt: string; endsAt: string; status: string }
  workpapers: HgbWorkpaperRecordView[]
}

export interface HgbCloseRunView {
  id: string
  version: number
  status: 'BLOCKED' | 'READY_TO_LOCK'
  ledgerFingerprint: string
  payload?: { readiness?: { blockers?: Array<{ code: string; message: string; authority: string }>; size?: string; notesRequired?: boolean }; blockers?: Array<{ code: string; message: string; authority: string }> }
  createdAt?: string
}

export interface HgbCloseOverview {
  ledgerFingerprint?: string
  runs: HgbCloseRunView[]
}

export interface HgbCloseApi {
  loadOverview(year: number, signal?: AbortSignal, tenantId?: string): Promise<HgbCloseOverview>
  loadWorkpapers(year: number, signal?: AbortSignal, tenantId?: string): Promise<HgbWorkpaperCollection>
  saveWorkpaper(year: number, draft: HgbWorkpaperDraft, expectedChecksum?: string, tenantId?: string): Promise<HgbWorkpaperRecordView>
  prepareWorkpaper(year: number, record: HgbWorkpaperRecordView, tenantId?: string): Promise<void>
  reviewWorkpaper(year: number, record: HgbWorkpaperRecordView, decision: 'APPROVE' | 'REJECT', reason?: string, tenantId?: string): Promise<void>
  postAdjustment(year: number, record: HgbWorkpaperRecordView, proposalId: string, tenantId?: string): Promise<void>
  evaluate(year: number, input: Omit<HgbCloseReadinessInput, 'profile' | 'workpapers'> & { reason: string }, tenantId?: string): Promise<void>
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(body?.error || body?.message || `Request failed (${response.status})`)
  return (body?.data ?? body) as T
}

export const browserHgbCloseApi: HgbCloseApi = {
  loadOverview: (year, signal, tenantId) => request(`/api/fiscal-years/${year}/hgb-close${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`, { signal }),
  loadWorkpapers: (year, signal, tenantId) => request(`/api/fiscal-years/${year}/hgb-close/workpapers${tenantId ? `?tenantId=${encodeURIComponent(tenantId)}` : ''}`, { signal }),
  saveWorkpaper: (year, workpaper, expectedChecksum, tenantId) => request(`/api/fiscal-years/${year}/hgb-close/workpapers`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ workpaper, expectedChecksum, tenantId }) }),
  prepareWorkpaper: async (year, record, tenantId) => { await request(`/api/fiscal-years/${year}/hgb-close/workpapers/${record.id}/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedChecksum: record.checksum, tenantId }) }) },
  reviewWorkpaper: async (year, record, decision, reason, tenantId) => { await request(`/api/fiscal-years/${year}/hgb-close/workpapers/${record.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decision, reason, tenantId }) }) },
  postAdjustment: async (year, record, proposalId, tenantId) => { await request(`/api/fiscal-years/${year}/hgb-close/workpapers/${record.id}/adjustments/${encodeURIComponent(proposalId)}/post`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idempotencyKey: crypto.randomUUID(), tenantId }) }) },
  evaluate: async (year, input, tenantId) => { await request(`/api/fiscal-years/${year}/hgb-close`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...input, tenantId }) }) },
}

export function operationStillCurrent(requestedYear: number, activeYear: number, generation: number, activeGeneration: number) {
  return requestedYear === activeYear && generation === activeGeneration
}

export function latestRunBlockers(run?: HgbCloseRunView) {
  return run?.payload?.readiness?.blockers ?? run?.payload?.blockers ?? []
}
