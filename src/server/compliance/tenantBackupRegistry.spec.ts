import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tenantBackupNestedModels, tenantBackupRegistry } from './tenantBackupRegistry'

function prismaModels() {
  const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8')
  return new Map([...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)].map(match => [match[1], match[2]]))
}

describe('tenant backup registry completeness', () => {
  it('Given the deployed Prisma schema, when tenant-owned models are enumerated, then every owner-scoped model is registered exactly once', () => {
    const models = prismaModels()
    const ownerScoped = [...models].filter(([, body]) => /\bownerId\s+String\??(?:\s|@)/.test(body)).map(([name]) => name).sort()
    const registered = tenantBackupRegistry.map(definition => definition.model).sort()

    expect(new Set(registered).size).toBe(registered.length)
    expect(registered).toEqual(ownerScoped)
    expect(new Set(tenantBackupRegistry.map(definition => definition.snapshotKey)).size).toBe(tenantBackupRegistry.length)
    expect(new Set(tenantBackupRegistry.map(definition => definition.delegate)).size).toBe(tenantBackupRegistry.length)
  })

  it('Given registered relational models, when restore order is checked, then every tenant parent is restored before its children', () => {
    const models = prismaModels()
    const definitions = new Map(tenantBackupRegistry.map(definition => [definition.model, definition]))
    for (const definition of tenantBackupRegistry) {
      const body = models.get(definition.model) ?? ''
      const relatedModels = [...body.matchAll(/^\s*\w+\s+(\w+)\??\s+@relation\(/gm)].map(match => match[1])
      for (const relatedModel of relatedModels) {
        const dependency = definitions.get(relatedModel)
        if (dependency && dependency.model !== definition.model) {
          expect(dependency.order, `${relatedModel} must restore before ${definition.model}`).toBeLessThan(definition.order)
        }
      }
    }
    expect(tenantBackupNestedModels).toEqual(['JournalLine', 'JournalDocumentAttachment'])
    expect(definitions.get('JournalEntry')!.order).toBeLessThan(definitions.get('VatPostingRecord')!.order)
  })

  it('Given binary and externally stored tenant data, when registry controls are inspected, then bytes and object locators cannot be silently dropped', () => {
    expect(tenantBackupRegistry.find(definition => definition.model === 'StructuredInvoice')?.binaryFields).toEqual(['structuredOriginal', 'visualOriginal'])
    expect(tenantBackupRegistry.find(definition => definition.model === 'BankStatement')?.binaryFields).toEqual(['originalXml'])
    expect(tenantBackupRegistry.filter(definition => definition.storageFields?.length).map(definition => definition.model).sort()).toEqual([
      'CompliancePackage', 'DocumentStorageClaim', 'EBalanceLifecycleReport', 'InvoiceIssuanceRequest', 'TaxAssessmentRecord',
    ])
  })

  it('Given production tenant access roles, when the backup registry is inspected, then membership authorization survives tenant backup and isolated verification', () => {
    expect(tenantBackupRegistry.find(definition => definition.model === 'TenantMembership')).toMatchObject({ delegate: 'tenantMembership', snapshotKey: 'tenantMemberships', mode: 'membership' })
  })
})
