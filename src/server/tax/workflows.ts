import 'server-only'

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  DeclarationWorkflow,
  TaxDeclarationError,
  cancelWithGateway,
  createConfiguredDeclarationWorkflowAuthenticator,
  createConfiguredDeclarationWorkflowStore,
  createConfiguredOfficialTaxGateway,
  finalizeAcceptedCorrection,
  recoverWithGateway,
  restoreDeclarationWorkflow,
  submitWithGateway,
  taxFormRegistry,
  validateWithGateway,
  declarationDatasetHash,
  type DeclarationDataset,
  type DeclarationKind,
  type DeclarationWorkflowPersistence,
  type OfficialTaxGateway,
  type PersistedDeclarationWorkflow,
  type TestOfficialTaxGatewayAdapter,
} from '@/core/taxDeclarations'
import { prisma } from '@/server/persistence/client'
import { reconcileAssessment, type Assessment } from '@/core/annualTax'
import { annualTaxApplicability, revalidatePreparedAnnualDataset } from './annualRepository'
import { currentReconciledVatDataset } from './vatRepository'
import { secureServiceEndpoint } from './transport'
import { isPrismaInt } from './persistenceLimits'
import { assertProductionGatewayReady, assertTenantTaxReadiness, gatewayOperationalEvent } from './operations'

export class TaxGatewayConfigurationError extends Error {}

type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

async function releaseFilingReservation(transaction: TransactionClient, ownerId: string, submissionId: string, correctsId: string | null) {
  let rootId = correctsId ?? submissionId
  const seen = new Set<string>()
  while (true) {
    if (seen.has(rootId)) throw new TaxDeclarationError(['The cancelled declaration correction chain is cyclic.'])
    seen.add(rootId)
    const row = await transaction.taxWorkflowRecord.findFirst({ where: { submissionId: rootId, ownerId }, select: { correctsId: true } })
    if (!row) throw new TaxDeclarationError(['The cancelled declaration correction chain is incomplete.'])
    if (!row.correctsId) break
    rootId = row.correctsId
  }
  await transaction.taxSubmissionRequest.updateMany({ where: { ownerId, submissionId: rootId, filingKey: { not: null } }, data: { filingKey: null, status: 'CANCELLED' } })
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`
  throw new TaxDeclarationError(['Tax workflow data contains an unsupported value.'])
}

function workflowData(record: PersistedDeclarationWorkflow) {
  const snapshot = record.snapshot
  return {
    submissionId: snapshot.submissionId,
    ownerId: snapshot.dataset.taxpayerId,
    kind: snapshot.dataset.kind,
    period: snapshot.dataset.period,
    state: snapshot.state,
    revision: record.revision,
    idempotencyKey: snapshot.idempotencyKey,
    payload: stableJson(record),
    receipt: snapshot.receipt,
    correctsId: snapshot.correctsId,
  }
}

async function saveRecord(transaction: TransactionClient, record: PersistedDeclarationWorkflow) {
  const data = workflowData(record)
  const current = await transaction.taxWorkflowRecord.findUnique({ where: { submissionId: data.submissionId } })
  if (current && (current.ownerId !== data.ownerId || current.revision > data.revision || current.revision === data.revision && current.payload !== data.payload)) return false
  if (current) await transaction.taxWorkflowRecord.update({ where: { submissionId: data.submissionId }, data })
  else await transaction.taxWorkflowRecord.create({ data })
  if (data.state === 'cancelled') await releaseFilingReservation(transaction, data.ownerId, data.submissionId, data.correctsId ?? null)
  return true
}

function prismaWorkflowPersistence(): DeclarationWorkflowPersistence {
  class WorkflowPersistenceConflict extends Error {}
  return {
    save: record => prisma.$transaction(transaction => saveRecord(transaction, record)),
    saveWithActionReservation: async (record, targetSubmissionId, actionId) => {
      try { return await prisma.$transaction(async transaction => {
        const ownerId = record.snapshot.dataset.taxpayerId
        const target = await transaction.taxWorkflowRecord.findFirst({ where: { submissionId: targetSubmissionId, ownerId } })
        if (!target || target.state !== 'accepted' || target.actionReservation && target.actionReservation !== actionId) return false
        await transaction.taxWorkflowRecord.update({ where: { submissionId: targetSubmissionId }, data: { actionReservation: actionId } })
        if (!await saveRecord(transaction, record)) throw new WorkflowPersistenceConflict()
        return true
      }) } catch (error) { if (error instanceof WorkflowPersistenceConflict) return false; throw error }
    },
    saveWithActionRelease: (record, targetSubmissionId, actionId) => prisma.$transaction(async transaction => {
      const target = await transaction.taxWorkflowRecord.findFirst({ where: { submissionId: targetSubmissionId, ownerId: record.snapshot.dataset.taxpayerId } })
      if (!target || target.actionReservation !== actionId || !await saveRecord(transaction, record)) return false
      await transaction.taxWorkflowRecord.update({ where: { submissionId: targetSubmissionId }, data: { actionReservation: null } })
      return true
    }),
    load: async submissionId => {
      const record = await prisma.taxWorkflowRecord.findUnique({ where: { submissionId }, select: { payload: true } })
      return record ? JSON.parse(record.payload) : undefined
    },
    loadRevision: async submissionId => (await prisma.taxWorkflowRecord.findUnique({ where: { submissionId }, select: { revision: true } }))?.revision,
    remove: async submissionId => { await prisma.taxWorkflowRecord.deleteMany({ where: { submissionId } }) },
    removeWithActionRelease: async (submissionId, targetSubmissionId, actionId) => { await prisma.$transaction(async transaction => { await transaction.taxWorkflowRecord.deleteMany({ where: { submissionId } }); await transaction.taxWorkflowRecord.updateMany({ where: { submissionId: targetSubmissionId, actionReservation: actionId }, data: { actionReservation: null } }) }) },
    reserveAction: (submissionId, actionId) => prisma.$transaction(async transaction => {
      const target = await transaction.taxWorkflowRecord.findUnique({ where: { submissionId } })
      if (!target || target.state !== 'accepted' || target.actionReservation && target.actionReservation !== actionId) return false
      await transaction.taxWorkflowRecord.update({ where: { submissionId }, data: { actionReservation: actionId } })
      return true
    }),
    releaseAction: async (submissionId, actionId) => { await prisma.taxWorkflowRecord.updateMany({ where: { submissionId, actionReservation: actionId }, data: { actionReservation: null } }) },
  }
}

let store: ReturnType<typeof createConfiguredDeclarationWorkflowStore> | undefined
const testWorkflowIntegrityMaterial = process.env.NODE_ENV === 'test' ? randomBytes(32).toString('hex') : ''
function workflowStore() {
  if (store) return store
  const key = process.env.TAX_WORKFLOW_INTEGRITY_MATERIAL ?? testWorkflowIntegrityMaterial
  if (key.length < 32) throw new TaxGatewayConfigurationError('TAX_WORKFLOW_INTEGRITY_MATERIAL must contain at least 32 characters.')
  const authenticator = createConfiguredDeclarationWorkflowAuthenticator({
    authenticate: payload => createHmac('sha256', key).update(payload).digest('hex'),
    verify: (payload, tag) => {
      if (!/^[a-f0-9]{64}$/.test(tag)) return false
      const expected = createHmac('sha256', key).update(payload).digest()
      return timingSafeEqual(expected, Buffer.from(tag, 'hex'))
    },
  }, `tax-workflow-hmac:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`)
  store = createConfiguredDeclarationWorkflowStore(prismaWorkflowPersistence(), authenticator, `prisma-tax-workflows:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`)
  return store
}

class HttpOfficialTaxAdapter implements TestOfficialTaxGatewayAdapter {
  constructor(private readonly endpoint: string, private readonly credential: string) {}
  private async call(action: string, body: Record<string, unknown>) {
    const startedAt = Date.now()
    let response: Response
    try { response = await fetch(`${this.endpoint}/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.credential}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }) }
    catch (error) {
      if (process.env.NODE_ENV === 'production') console.warn(JSON.stringify(gatewayOperationalEvent(action, error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network-error', Date.now() - startedAt)))
      throw error
    }
    if (process.env.NODE_ENV === 'production') console.info(JSON.stringify(gatewayOperationalEvent(action, response.ok ? 'success' : 'http-error', Date.now() - startedAt, response.status)))
    const candidate: unknown = await response.json().catch(() => null)
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new TaxDeclarationError(['The configured official gateway returned an invalid response.'])
    const value = candidate as Record<string, unknown>
    if (!response.ok) throw new TaxDeclarationError([typeof value.error === 'string' ? value.error : 'The configured official gateway rejected the request.'])
    return value
  }
  async validate(dataset: DeclarationDataset) { const value = await this.call('validate', { dataset }); return { valid: value.valid === true, errors: Array.isArray(value.errors) ? value.errors.filter((item): item is string => typeof item === 'string') : [], protocol: typeof value.protocol === 'string' ? value.protocol : undefined } }
  async submit(dataset: DeclarationDataset, idempotencyKey: string) { return this.outcome(await this.call('submit', { dataset, idempotencyKey })) }
  async correct(targetSubmissionId: string, dataset: DeclarationDataset, idempotencyKey: string) { return this.outcome(await this.call('correct', { targetSubmissionId, dataset, idempotencyKey })) }
  async cancel(targetSubmissionId: string, idempotencyKey: string) { return this.outcome(await this.call('cancel', { targetSubmissionId, idempotencyKey })) }
  async recover(idempotencyKey: string) { return this.outcome(await this.call('recover', { idempotencyKey })) }
  private outcome(value: Record<string, unknown>) {
    if (!['accepted', 'rejected', 'uncertain'].includes(String(value.outcome))) throw new TaxDeclarationError(['The configured official gateway returned an invalid filing outcome.'])
    return { outcome: value.outcome as 'accepted' | 'rejected' | 'uncertain', receipt: typeof value.receipt === 'string' ? value.receipt : undefined, errors: Array.isArray(value.errors) ? value.errors.filter((item): item is string => typeof item === 'string') : undefined }
  }
}

let gatewayOverride: TestOfficialTaxGatewayAdapter | undefined
let gateway: OfficialTaxGateway | undefined
let gatewayConfigurationId: string | undefined
export function setOfficialTaxGatewayForTests(adapter?: TestOfficialTaxGatewayAdapter) {
  if (process.env.NODE_ENV !== 'test') throw new TaxGatewayConfigurationError('The official tax gateway can only be replaced in tests.')
  gatewayOverride = adapter; gateway = undefined; gatewayConfigurationId = undefined
}
function officialGateway() {
  const configuredEndpoint = process.env.TAX_GATEWAY_URL
  let endpoint: string | undefined
  try { endpoint = configuredEndpoint ? secureServiceEndpoint(configuredEndpoint, 'TAX_GATEWAY_URL') : undefined }
  catch (error) { throw new TaxGatewayConfigurationError(error instanceof Error ? error.message : 'TAX_GATEWAY_URL is invalid.') }
  const credential = process.env.TAX_GATEWAY_CREDENTIAL?.trim()
  const adapter = gatewayOverride ?? (endpoint && credential ? new HttpOfficialTaxAdapter(endpoint, credential) : undefined)
  if (!adapter) throw new TaxGatewayConfigurationError('Configure TAX_GATEWAY_URL and TAX_GATEWAY_CREDENTIAL before official validation or transmission.')
  const configurationId = officialGatewayConfigurationId(endpoint, Boolean(gatewayOverride), credential)
  if (gateway && gatewayConfigurationId === configurationId) return gateway
  gateway = createConfiguredOfficialTaxGateway(adapter, configurationId, workflowStore())
  gatewayConfigurationId = configurationId
  return gateway
}

export function officialGatewayConfigurationId(endpoint: string | undefined, usesTestOverride: boolean, credential?: string) {
  const authority = usesTestOverride ? 'test-override' : endpoint
  if (!authority?.trim()) throw new TaxGatewayConfigurationError('A stable official tax gateway authority is required.')
  const rotationIdentity = credential ? `:${createHash('sha256').update(credential).digest('hex').slice(0, 12)}` : ''
  return `official-tax:${createHash('sha256').update(authority).digest('hex').slice(0, 24)}${rotationIdentity}`
}

export interface DatasetInput { kind: DeclarationKind; period: string; fields: Record<string, number | string | boolean>; drilldown?: Record<string, readonly string[]> }
export function prepareTenantDataset(ownerId: string, input: DatasetInput) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.kind !== 'string' || typeof input.period !== 'string' || !input.fields || typeof input.fields !== 'object' || Array.isArray(input.fields)) throw new TaxDeclarationError(['A canonical declaration kind, period and fields object are required.'])
  return taxFormRegistry.prepare(input.kind, input.period, input.fields, input.drilldown ?? {}, ownerId)
}

function datasetHash(dataset: DeclarationDataset) { return createHash('sha256').update(stableJson(dataset)).digest('hex') }
const annualKinds = new Set<DeclarationKind>(['KST', 'GEWST', 'ZERLEGUNG', 'EST_BUSINESS', 'FESTSTELLUNG'])
async function requireCurrentPreparedDataset(ownerId: string, dataset: DeclarationDataset) {
  if (dataset.kind !== 'USTVA' && !annualKinds.has(dataset.kind)) return
  if (annualKinds.has(dataset.kind)) {
    const year = Number(dataset.period)
    const applicability = await annualTaxApplicability(ownerId, year)
    if (!applicability.kinds.includes(dataset.kind)) throw new TaxDeclarationError(['The annual declaration kind is not applicable to the tenant current canonical profile.'])
  }
  const prepared = await prisma.taxDatasetPreparationRecord.findUnique({ where: { ownerId_datasetHash: { ownerId, datasetHash: declarationDatasetHash(dataset) } } })
  if (!prepared || prepared.kind !== dataset.kind || prepared.period !== dataset.period) throw new TaxDeclarationError(['Binding tax submission requires the exact tenant-scoped reconciled dataset produced by tax preparation.'])
  if (dataset.kind === 'USTVA') {
    const current = await currentReconciledVatDataset(ownerId, dataset.period)
    if (declarationDatasetHash(current.dataset) !== declarationDatasetHash(dataset)) throw new TaxDeclarationError(['The VAT sources changed after preparation; reconcile and approve the current dataset again.'])
  } else {
    await revalidatePreparedAnnualDataset(ownerId, dataset)
  }
}

async function claimSubmission(ownerId: string, requestKey: string, dataset: DeclarationDataset, operation: string) {
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(requestKey)) throw new TaxDeclarationError(['A canonical 16-100 character request key is required.'])
  const hash = createHash('sha256').update(`${operation}\u0000${datasetHash(dataset)}`).digest('hex')
  const submissionId = createHash('sha256').update(`${ownerId}\u0000${requestKey}\u0000${operation}`).digest('hex')
  const filingKey = operation === 'submit' ? createHash('sha256').update(`${ownerId}\u0000${dataset.kind}\u0000${dataset.period}`).digest('hex') : null
  const existing = await prisma.taxSubmissionRequest.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey } } })
  if (existing) {
    if (existing.datasetHash !== hash) throw new TaxDeclarationError(['The request key is already bound to a different declaration dataset.'])
    const workflow = existing.submissionId ? await prisma.taxWorkflowRecord.findFirst({ where: { submissionId: existing.submissionId, ownerId } }) : null
    if (workflow) return { record: existing, claimed: false }
    const stale = existing.status === 'FAILED' || Date.now() - existing.updatedAt.getTime() > 5 * 60_000
    if (!stale) return { record: existing, claimed: false }
    try { return { record: await prisma.taxSubmissionRequest.update({ where: { id: existing.id }, data: { status: 'PROCESSING', error: null, submissionId, filingKey } }), claimed: true } }
    catch { throw new TaxDeclarationError(['An original declaration already exists or is being processed for this tenant, kind and period; use its correction workflow.']) }
  }
  try { return { record: await prisma.taxSubmissionRequest.create({ data: { ownerId, requestKey, datasetHash: hash, submissionId, filingKey } }), claimed: true } }
  catch {
    const winner = await prisma.taxSubmissionRequest.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey } } })
    if (!winner && filingKey) {
      const filingWinner = await prisma.taxSubmissionRequest.findUnique({ where: { filingKey } })
      const workflow = filingWinner?.submissionId ? await prisma.taxWorkflowRecord.findFirst({ where: { submissionId: filingWinner.submissionId, ownerId } }) : null
      const stale = filingWinner && !workflow && (filingWinner.status === 'FAILED' || Date.now() - filingWinner.updatedAt.getTime() > 5 * 60_000)
      if (filingWinner && stale) {
        const reclaimed = await prisma.taxSubmissionRequest.updateMany({ where: { id: filingWinner.id, ownerId, updatedAt: filingWinner.updatedAt, status: filingWinner.status }, data: { requestKey, datasetHash: hash, submissionId, status: 'PROCESSING', error: null } })
        if (reclaimed.count === 1) return { record: await prisma.taxSubmissionRequest.findUniqueOrThrow({ where: { ownerId_requestKey: { ownerId, requestKey } } }), claimed: true }
      }
    }
    if (!winner) throw new TaxDeclarationError(['An original declaration already exists or is being processed for this tenant, kind and period; use its correction workflow.'])
    if (winner.datasetHash !== hash) throw new TaxDeclarationError(['The request key is already bound to a different declaration dataset.'])
    return { record: winner, claimed: false }
  }
}

async function replaySubmission(ownerId: string, requestKey: string, dataset: DeclarationDataset, operation: string) {
  if (!/^[A-Za-z0-9._:-]{16,100}$/.test(requestKey)) throw new TaxDeclarationError(['A canonical 16-100 character request key is required.'])
  const hash = createHash('sha256').update(`${operation}\u0000${datasetHash(dataset)}`).digest('hex')
  const existing = await prisma.taxSubmissionRequest.findUnique({ where: { ownerId_requestKey: { ownerId, requestKey } } })
  if (!existing) return null
  if (existing.datasetHash !== hash) throw new TaxDeclarationError(['The request key is already bound to a different declaration dataset.'])
  if (!existing.submissionId) return null
  const row = await prisma.taxWorkflowRecord.findFirst({ where: { submissionId: existing.submissionId, ownerId } })
  return row ? publicWorkflow(row) : null
}

export async function validateTaxDataset(ownerId: string, input: DatasetInput) {
  const dataset = prepareTenantDataset(ownerId, input)
  const validated = await validateWithGateway(DeclarationWorkflow.create(dataset), officialGateway())
  return { valid: validated.state === 'validated', dataset }
}

export async function submitTaxDataset(ownerId: string, actorId: string, requestKey: string, input: DatasetInput) {
  const dataset = prepareTenantDataset(ownerId, input)
  const replay = await replaySubmission(ownerId, requestKey, dataset, 'submit')
  if (replay) return replay
  await requireCurrentPreparedDataset(ownerId, dataset)
  assertProductionGatewayReady(dataset.formVersion)
  await assertTenantTaxReadiness(ownerId, dataset.kind, dataset.period)
  const taxGateway = officialGateway()
  const claim = await claimSubmission(ownerId, requestKey, dataset, 'submit')
  if (!claim.claimed) {
    if (!claim.record.submissionId || !await prisma.taxWorkflowRecord.findFirst({ where: { submissionId: claim.record.submissionId, ownerId } })) throw new TaxDeclarationError(['This declaration request is already being processed; recover its outcome before retrying.'])
    const row = await ownedWorkflow(ownerId, claim.record.submissionId)
    return await publicWorkflow(row)
  }
  try {
    const validated = await validateWithGateway(DeclarationWorkflow.create(dataset, new Date().toISOString(), claim.record.submissionId!), taxGateway)
    const result = await submitWithGateway(validated.approved(actorId), taxGateway)
    await prisma.taxSubmissionRequest.update({ where: { id: claim.record.id }, data: { status: result.state.toUpperCase(), submissionId: result.submissionId, filingKey: result.state === 'rejected' ? null : claim.record.filingKey } })
    return await publicWorkflow(await ownedWorkflow(ownerId, result.submissionId))
  } catch (error) {
    const persisted = claim.record.submissionId ? await prisma.taxWorkflowRecord.findFirst({ where: { submissionId: claim.record.submissionId, ownerId } }) : null
    const externallyUncertain = Boolean(persisted && ['accepted', 'submitting', 'uncertain'].includes(persisted.state))
    await prisma.taxSubmissionRequest.update({ where: { id: claim.record.id }, data: { status: externallyUncertain ? 'UNKNOWN' : 'FAILED', error: error instanceof Error ? error.message : 'Unknown filing error', filingKey: externallyUncertain ? claim.record.filingKey : null } })
    throw error
  }
}

export async function correctTaxWorkflow(ownerId: string, actorId: string, targetId: string, requestKey: string, input: DatasetInput) {
  const dataset = prepareTenantDataset(ownerId, input)
  const replay = await replaySubmission(ownerId, requestKey, dataset, `correct:${targetId}`)
  if (replay) {
    if (replay.state === 'accepted') await finalizePersistedCorrection(ownerId, replay.submissionId)
    return await publicWorkflow(await ownedWorkflow(ownerId, replay.submissionId))
  }
  const target = await ownedWorkflow(ownerId, targetId)
  const original = await restoreDeclarationWorkflow(target.submissionId, workflowStore())
  await requireCurrentPreparedDataset(ownerId, dataset)
  assertProductionGatewayReady(dataset.formVersion)
  await assertTenantTaxReadiness(ownerId, dataset.kind, dataset.period)
  const taxGateway = officialGateway()
  const claim = await claimSubmission(ownerId, requestKey, dataset, `correct:${targetId}`)
  if (!claim.claimed) {
    if (!claim.record.submissionId || !await prisma.taxWorkflowRecord.findFirst({ where: { submissionId: claim.record.submissionId, ownerId } })) throw new TaxDeclarationError(['This correction request is already being processed.'])
    await finalizePersistedCorrection(ownerId, claim.record.submissionId)
    return await publicWorkflow(await ownedWorkflow(ownerId, claim.record.submissionId))
  }
  try {
    const correction = original.correction(dataset, new Date().toISOString(), claim.record.submissionId!).correction
    const validated = await validateWithGateway(correction, taxGateway)
    const accepted = await submitWithGateway(validated.approved(actorId), taxGateway)
    if (accepted.state === 'accepted') await finalizeAcceptedCorrection(original, accepted, workflowStore())
    await prisma.taxSubmissionRequest.update({ where: { id: claim.record.id }, data: { status: accepted.state.toUpperCase(), submissionId: accepted.submissionId } })
    return await publicWorkflow(await ownedWorkflow(ownerId, accepted.submissionId))
  } catch (error) {
    const persisted = claim.record.submissionId ? await prisma.taxWorkflowRecord.findFirst({ where: { submissionId: claim.record.submissionId, ownerId } }) : null
    await prisma.taxSubmissionRequest.update({ where: { id: claim.record.id }, data: { status: persisted ? 'UNKNOWN' : 'FAILED', error: error instanceof Error ? error.message : 'Unknown correction error' } })
    throw error
  }
}

export async function cancelTaxWorkflow(ownerId: string, actorId: string, submissionId: string) {
  const row = await ownedWorkflow(ownerId, submissionId)
  if (row.state === 'cancelled') { await releaseCancelledFilingReservation(ownerId, submissionId); return await publicWorkflow(row) }
  assertProductionGatewayReady(taxFormRegistry.resolve(row.kind as DeclarationKind, row.period).version)
  const result = await cancelWithGateway(await restoreDeclarationWorkflow(submissionId, workflowStore()), actorId, officialGateway())
  if (result.state === 'cancelled') await releaseCancelledFilingReservation(ownerId, result.submissionId)
  return await publicWorkflow(await ownedWorkflow(ownerId, result.submissionId))
}

async function releaseCancelledFilingReservation(ownerId: string, submissionId: string) {
  const row = await ownedWorkflow(ownerId, submissionId)
  if (row.state !== 'cancelled') return
  await prisma.$transaction(transaction => releaseFilingReservation(transaction, ownerId, row.submissionId, row.correctsId))
}

export async function recoverTaxWorkflow(ownerId: string, submissionId: string) {
  await ownedWorkflow(ownerId, submissionId)
  const result = await recoverWithGateway(await restoreDeclarationWorkflow(submissionId, workflowStore()), officialGateway())
  if (result.state === 'accepted' && result.correctsId) await finalizePersistedCorrection(ownerId, result.submissionId)
  return await publicWorkflow(await ownedWorkflow(ownerId, result.submissionId))
}

async function finalizePersistedCorrection(ownerId: string, submissionId: string) {
  const correctionRow = await ownedWorkflow(ownerId, submissionId)
  if (correctionRow.state !== 'accepted' || !correctionRow.correctsId) return
  const originalRow = await ownedWorkflow(ownerId, correctionRow.correctsId)
  if (originalRow.state === 'corrected') return
  if (originalRow.state !== 'accepted') throw new TaxDeclarationError(['An accepted correction requires its original declaration to remain accepted until finalization.'])
  await finalizeAcceptedCorrection(await restoreDeclarationWorkflow(originalRow.submissionId, workflowStore()), await restoreDeclarationWorkflow(correctionRow.submissionId, workflowStore()), workflowStore())
}

export async function listTaxWorkflows(ownerId: string) {
  const rows = await prisma.taxWorkflowRecord.findMany({ where: { ownerId }, orderBy: [{ updatedAt: 'desc' }, { submissionId: 'desc' }] })
  return Promise.all(rows.map(async row => {
    const workflow = await restoreDeclarationWorkflow(row.submissionId, workflowStore())
    const authenticated = JSON.parse(row.payload) as PersistedDeclarationWorkflow
    return { submissionId: workflow.submissionId, kind: workflow.dataset.kind, period: workflow.dataset.period, state: workflow.state, revision: authenticated.revision, receipt: workflow.receipt ?? null, correctsId: workflow.correctsId ?? null, dataset: workflow.dataset, events: workflow.events, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
  }))
}

export async function recordTaxAssessment(ownerId: string, input: Omit<Assessment, 'taxpayerId'>) {
  if (!input || !isPrismaInt(input.assessedAmountCents)) throw new TaxDeclarationError(['The assessed amount must fit signed 32-bit integer cents storage.'])
  const row = await ownedWorkflow(ownerId, input.declarationSubmissionId)
  const workflow = await restoreDeclarationWorkflow(row.submissionId, workflowStore())
  const assessment: Assessment = { ...input, taxpayerId: ownerId }
  const result = reconcileAssessment(assessment, workflow)
  if (!isPrismaInt(result.differenceCents)) throw new TaxDeclarationError(['The assessment difference exceeds signed 32-bit integer cents storage.'])
  return prisma.taxAssessmentRecord.create({ data: {
    id: input.id, ownerId, kind: input.kind, period: input.period,
    assessedAmountCents: input.assessedAmountCents, receivedAt: new Date(`${input.receivedAt}T00:00:00.000Z`),
    documentHash: input.documentHash, declarationSubmissionId: input.declarationSubmissionId,
    differenceCents: result.differenceCents, needsReview: result.needsReview,
  } })
}

export async function listTaxAssessments(ownerId: string) {
  return prisma.taxAssessmentRecord.findMany({ where: { ownerId }, orderBy: { receivedAt: 'desc' } })
}

async function ownedWorkflow(ownerId: string, submissionId: string) {
  const row = await prisma.taxWorkflowRecord.findFirst({ where: { submissionId, ownerId } })
  if (!row) throw new TaxDeclarationError(['The declaration workflow does not exist for this tenant.'])
  return row
}

async function publicWorkflow(row: { submissionId: string; ownerId: string; kind: string; period: string; state: string; revision: number; payload: string; receipt: string | null; correctsId: string | null; createdAt: Date; updatedAt: Date }) {
  const authenticated = await restoreDeclarationWorkflow(row.submissionId, workflowStore())
  if (authenticated.dataset.taxpayerId !== row.ownerId) throw new TaxDeclarationError(['The authenticated declaration tenant does not match its persisted owner.'])
  return { submissionId: authenticated.submissionId, kind: authenticated.dataset.kind, period: authenticated.dataset.period, state: authenticated.state, revision: row.revision, receipt: authenticated.receipt ?? null, correctsId: authenticated.correctsId ?? null, dataset: authenticated.dataset, events: authenticated.events, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() }
}
