export type TenantBackupDefinition = {
  model: string
  delegate: string
  snapshotKey: string
  table: string
  order: number
  shape?: 'many' | 'singleton'
  mode?: 'standard' | 'journalGraph' | 'backupManifests' | 'derivedOpenItem' | 'derivedSettlement' | 'allocationReplay' | 'membership'
  binaryFields?: readonly string[]
  storageFields?: readonly string[]
}

const collection = (model: string, delegate: string, snapshotKey: string, order: number, extra: Partial<TenantBackupDefinition> = {}): TenantBackupDefinition => ({
  model, delegate, snapshotKey, table: model, order, shape: 'many', mode: 'standard', ...extra,
})

export const tenantBackupRegistry = [
  collection('AccountRecord', 'accountRecord', 'settings', 10),
  collection('TenantMembership', 'tenantMembership', 'tenantMemberships', 10, { mode: 'membership' }),
  collection('CompanyProfileVersion', 'companyProfileVersion', 'profiles', 10),
  collection('CompanyProfileAddressConfirmation', 'companyProfileAddressConfirmation', 'profileAddressConfirmations', 10),
  collection('CompliancePolicy', 'compliancePolicy', 'policy', 10, { shape: 'singleton' }),
  collection('CompliancePackage', 'compliancePackage', 'compliancePackages', 10, { storageFields: ['storageKey'] }),
  collection('ProcedureDocumentRecord', 'procedureDocumentRecord', 'procedureDocuments', 10),
  collection('FixedAssetRecord', 'fixedAssetRecord', 'fixedAssets', 10),
  collection('AssetEventRecord', 'assetEventRecord', 'assetEvents', 10),
  collection('InventoryItemRecord', 'inventoryItemRecord', 'inventoryItems', 10),
  collection('InventoryCountSnapshot', 'inventoryCountSnapshot', 'inventoryCountSnapshots', 10),
  collection('CashBookRecord', 'cashBookRecord', 'cashBooks', 10),
  collection('CashEntryRecord', 'cashEntryRecord', 'cashEntries', 10),
  collection('CashCloseRecord', 'cashCloseRecord', 'cashCloses', 10),
  collection('DocumentRecord', 'documentRecord', 'documents', 10),
  collection('DocumentStorageClaim', 'documentStorageClaim', 'storageClaims', 10, { storageFields: ['storageKey'] }),
  // Artifact storage is lifecycle-aware and is resolved by snapshotStorageReferences.
  collection('RetainedArtifact', 'retainedArtifact', 'artifacts', 10),
  collection('FixityCheck', 'fixityCheck', 'fixityChecks', 10),
  collection('LedgerAccount', 'ledgerAccount', 'accounts', 10),
  collection('AccountMappingVersion', 'accountMappingVersion', 'mappings', 10),
  collection('LedgerProfile', 'ledgerProfile', 'ledgerProfile', 10, { shape: 'singleton' }),
  collection('LexwareCompanySetup', 'lexwareCompanySetup', 'lexwareCompanySetups', 10),
  collection('LexwareAccountMetadata', 'lexwareAccountMetadata', 'lexwareAccountMetadata', 10),
  collection('LexwareTrialBalanceLine', 'lexwareTrialBalanceLine', 'lexwareTrialBalanceLines', 10),
  collection('LexwareBusinessPartner', 'lexwareBusinessPartner', 'lexwareBusinessPartners', 10),
  collection('LexwareSubledgerAssociation', 'lexwareSubledgerAssociation', 'lexwareSubledgerAssociations', 10),
  collection('LexwareAnnualVatField', 'lexwareAnnualVatField', 'lexwareAnnualVatFields', 10),
  collection('FiscalYear', 'fiscalYear', 'periods', 10),
  collection('HgbWorkpaperRecord', 'hgbWorkpaperRecord', 'hgbWorkpapers', 10),
  collection('HgbAdjustmentRecord', 'hgbAdjustmentRecord', 'hgbAdjustments', 10),
  collection('JournalDraft', 'journalDraft', 'drafts', 10),
  collection('PeriodReopenRequest', 'periodReopenRequest', 'reopenRequests', 10),
  collection('FilingAmendment', 'filingAmendment', 'amendments', 10),
  collection('BusinessPartner', 'businessPartner', 'businessPartners', 10),
  collection('InvoiceNumberSequence', 'invoiceNumberSequence', 'invoiceNumberSequences', 10),
  collection('InvoiceNumberSequenceOnboarding', 'invoiceNumberSequenceOnboarding', 'invoiceNumberOnboarding', 10),
  collection('InvoiceNumberReservation', 'invoiceNumberReservation', 'invoiceNumberReservations', 10),
  collection('InvoiceIssuanceRequest', 'invoiceIssuanceRequest', 'invoiceIssuanceRequests', 10, { storageFields: ['storageKey'] }),
  collection('VatReversalMarker', 'vatReversalMarker', 'vatReversalMarkers', 10),
  collection('TaxWorkflowRecord', 'taxWorkflowRecord', 'taxWorkflows', 10),
  collection('TaxSubmissionRequest', 'taxSubmissionRequest', 'taxSubmissionRequests', 10),
  collection('TaxAdjustmentRecord', 'taxAdjustmentRecord', 'taxAdjustments', 10),
  collection('AuditEvent', 'auditEvent', 'audit', 20),
  collection('AuditHead', 'auditHead', 'auditHead', 21, { shape: 'singleton' }),
  collection('BackupManifest', 'backupManifest', 'backupManifests', 20, { mode: 'backupManifests' }),
  collection('DocumentExtraction', 'documentExtraction', 'documentExtractions', 20),
  collection('BankAccount', 'bankAccount', 'bankAccounts', 20),
  collection('HgbCloseRun', 'hgbCloseRun', 'hgbCloseRuns', 20),
  collection('StructuredInvoice', 'structuredInvoice', 'structuredInvoices', 20, { binaryFields: ['structuredOriginal', 'visualOriginal'] }),
  collection('BankStatement', 'bankStatement', 'bankStatements', 30, { binaryFields: ['originalXml'] }),
  collection('FiscalCloseGeneration', 'fiscalCloseGeneration', 'fiscalCloseGenerations', 30),
  collection('JournalEntry', 'journalEntry', 'entries', 30, { mode: 'journalGraph' }),
  collection('EBalanceReconciliationRecord', 'eBalanceReconciliationRecord', 'eBalanceReconciliations', 30),
  collection('BankTransaction', 'bankTransaction', 'bankTransactions', 40),
  collection('EBalanceSubmission', 'eBalanceSubmission', 'eBalanceSubmissions', 40),
  collection('EBalanceLifecycleReport', 'eBalanceLifecycleReport', 'eBalanceLifecycleReports', 40, { storageFields: ['storageKey'] }),
  collection('VatPostingRecord', 'vatPostingRecord', 'vatPostings', 40),
  collection('CommercialDocument', 'commercialDocument', 'commercialDocuments', 40),
  collection('TaxAnnualCaseRecord', 'taxAnnualCaseRecord', 'taxAnnualCases', 40),
  collection('OpenItem', 'openItem', 'openItems', 50, { mode: 'derivedOpenItem' }),
  collection('PaymentSettlement', 'paymentSettlement', 'paymentSettlements', 50, { mode: 'derivedSettlement' }),
  collection('TaxDatasetPreparationRecord', 'taxDatasetPreparationRecord', 'taxDatasetPreparations', 50),
  collection('TaxAssessmentRecord', 'taxAssessmentRecord', 'taxAssessments', 50, { storageFields: ['evidenceStorageKey'] }),
  collection('CorrectionNetting', 'correctionNetting', 'correctionNettings', 55),
  collection('SettlementAllocation', 'settlementAllocation', 'settlementAllocations', 60, { mode: 'allocationReplay' }),
  collection('ReceivablesReminder', 'receivablesReminder', 'receivablesReminders', 55),
  collection('ReceivablesReminderDeliveryAttempt', 'receivablesReminderDeliveryAttempt', 'receivablesReminderDeliveryAttempts', 60),
  collection('ReceivablesReminderDeliveryResult', 'receivablesReminderDeliveryResult', 'receivablesReminderDeliveryResults', 65),
  collection('BankTransactionMatch', 'bankTransactionMatch', 'bankTransactionMatches', 70),
  collection('ReceivablesReminderCancellation', 'receivablesReminderCancellation', 'receivablesReminderCancellations', 70),
] as const satisfies readonly TenantBackupDefinition[]

export const tenantBackupCollections = tenantBackupRegistry.filter(definition => definition.shape !== 'singleton')
export const tenantBackupSingletons = tenantBackupRegistry.filter(definition => definition.shape === 'singleton')
export const tenantBackupNestedModels = ['JournalLine', 'JournalDocumentAttachment'] as const

type PrismaDelegate = { findMany?: (query: unknown) => Promise<any[]>; findUnique?: (query: unknown) => Promise<any> }

function serializeRows(definition: TenantBackupDefinition, rows: any[]) {
  const binaryFields = definition.binaryFields ?? []
  return rows.map(row => Object.fromEntries(Object.entries(row).map(([field, value]) => [
    field,
    binaryFields.includes(field) && value != null ? Buffer.from(value as Uint8Array).toString('base64') : value,
  ])))
}

export async function captureRegisteredTenantSnapshot(transaction: Record<string, PrismaDelegate>, ownerId: string) {
  const result: Record<string, unknown> = {}
  for (const definition of tenantBackupRegistry) {
    const delegate = transaction[definition.delegate]
    if (!delegate) throw new Error(`Prisma delegate ${definition.delegate} is unavailable for tenant backup`)
    if (definition.shape === 'singleton') {
      result[definition.snapshotKey] = await delegate.findUnique!({ where: { ownerId } })
      continue
    }
    const query: Record<string, unknown> = { where: { ownerId } }
    if (definition.mode === 'journalGraph') query.include = { lines: true, documents: true }
    if (definition.model === 'AuditEvent') query.orderBy = [{ occurredAt: 'asc' }, { createdAt: 'asc' }]
    let rows = serializeRows(definition, await delegate.findMany!(query))
    if (definition.mode === 'backupManifests') rows = rows.map(row => ({ ...row, payloadStorageKey: null, status: 'PAYLOAD_EXCLUDED' }))
    result[definition.snapshotKey] = rows
  }
  return result
}

export function registeredStorageReferences(snapshot: Record<string, any>): string[] {
  const references = new Set<string>()
  for (const definition of tenantBackupRegistry) for (const field of definition.storageFields ?? []) {
    const values = definition.shape === 'singleton' ? [snapshot[definition.snapshotKey]] : snapshot[definition.snapshotKey] ?? []
    for (const row of values) if (row && typeof row[field] === 'string' && row[field]) references.add(row[field])
  }
  return [...references]
}
