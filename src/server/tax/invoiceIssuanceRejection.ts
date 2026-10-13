import 'server-only'

import { createHash } from 'node:crypto'
import { prisma } from '@/server/persistence/client'

/** Retire a rejected key before telling the browser it may submit edited facts.
 * A read alone is unsafe: an earlier timed-out request could still claim it.
 * Processing requests and saved invoices must instead be replayed for recovery.
 */
export async function retireRejectedInvoiceRequest(ownerId: string, requestKey: unknown): Promise<boolean> {
  if (typeof requestKey !== 'string' || !/^[A-Za-z0-9._:-]{16,100}$/.test(requestKey)) return false
  return prisma.$transaction(async transaction => {
    const request = await transaction.invoiceIssuanceRequest.upsert({
      where: { ownerId_requestKey: { ownerId, requestKey } },
      create: {
        ownerId, requestKey, status: 'REJECTED',
        // No issuance was claimed. This terminal marker cannot be rebound.
        requestHash: createHash('sha256').update(`rejected:${requestKey}`).digest('hex'),
      },
      update: {},
    })
    if (request.structuredInvoiceId) return false
    if (request.status === 'REJECTED') return true
    if (request.status !== 'FAILED') return false
    const retired = await transaction.invoiceIssuanceRequest.updateMany({
      where: { id: request.id, ownerId, status: 'FAILED', structuredInvoiceId: null, updatedAt: request.updatedAt },
      data: { status: 'REJECTED' },
    })
    return retired.count === 1
  })
}
