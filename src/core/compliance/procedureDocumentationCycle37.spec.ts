import { describe, expect, it } from 'vitest'
import { createTenantProcedurePackage, REQUIRED_CONTROLS, REQUIRED_PROCEDURE_SECTIONS, selectHistoricProcedure, selectHistoricTenantProcedureSnapshot, validateProcedureVersion, type ProcedureDocumentVersion, type TenantProcedureDetails } from './procedureDocumentation'

function procedure(): ProcedureDocumentVersion {
  return { id: 'procedure-1', version: '1.0.0', effectiveFrom: '2026-01-01', approvedBy: 'Management', approvedAt: '2026-01-01T09:00:00Z', appVersion: '1', configurationVersion: '1', schemaVersion: '1', taxonomyVersions: ['6.10'], sections: Object.fromEntries(REQUIRED_PROCEDURE_SECTIONS.map(section => [section, `${section} process`])), controls: Object.fromEntries(REQUIRED_CONTROLS.map(control => [control, { description: control, ownerRole: 'Controller', evidenceReferences: [`evidence-${control}`] }])), changeLog: [{ changedAt: '2026-01-01', changedBy: 'Admin', summary: 'Created' }] }
}
const tenant: TenantProcedureDetails = { tenantId: 'tenant-1', legalName: 'Example GmbH', operatorRoles: { poster: 'Alice' }, procedures: { capture: 'Capture', posting: 'Posting', closing: 'Closing', 'backup-recovery': 'Backup' }, evidenceIndex: REQUIRED_CONTROLS.map(control => `evidence-${control}`) }

describe('cycle 37 procedure collection runtime guards', () => {
  it('returns issues for missing, string or object taxonomy/change-log collections without throwing', () => {
    for (const taxonomyVersions of [undefined, null, '6.10', { version: '6.10' }]) { const malformed = { ...procedure(), taxonomyVersions } as never; expect(() => validateProcedureVersion(malformed)).not.toThrow(); expect(validateProcedureVersion(malformed)).toContain('At least one nonblank taxonomy version is required.') }
    for (const changeLog of [undefined, null, 'changed', { changedAt: '2026-01-01' }]) { const malformed = { ...procedure(), changeLog } as never; expect(() => validateProcedureVersion(malformed)).not.toThrow(); expect(validateProcedureVersion(malformed)).toContain('At least one well-formed change-log entry with date, actor and summary is required.') }
  })

  it('rejects sparse taxonomy and change-log collections instead of skipping holes', () => {
    const sparseTaxonomies = ['6.10']; sparseTaxonomies.length = 2
    const sparseChangeLog = [...procedure().changeLog]; sparseChangeLog.length = 2
    expect(validateProcedureVersion({ ...procedure(), taxonomyVersions: sparseTaxonomies })).toContain('At least one nonblank taxonomy version is required.')
    expect(validateProcedureVersion({ ...procedure(), changeLog: sparseChangeLog })).toContain('At least one well-formed change-log entry with date, actor and summary is required.')
  })

  it('guards malformed sections, controls, control fields and nested evidence collections', () => {
    for (const patch of [{ sections: null }, { sections: 'sections' }, { controls: null }, { controls: [] }, { controls: { completeness: { description: 1, ownerRole: {}, evidenceReferences: 'evidence' } } }]) {
      const malformed = { ...procedure(), ...patch } as never
      expect(() => validateProcedureVersion(malformed)).not.toThrow()
      expect(validateProcedureVersion(malformed).length).toBeGreaterThan(0)
    }
  })

  it('requires sections, controls and control fields to be own enumerable data properties', () => {
    const inheritedSections = Object.create(procedure().sections)
    expect(validateProcedureVersion({ ...procedure(), sections: inheritedSections })).toContain('Missing required section: general')
    const inheritedControls = Object.create(procedure().controls)
    expect(validateProcedureVersion({ ...procedure(), controls: inheritedControls })).toContain('Incomplete required control: completeness')
    const inheritedControlFields = Object.create(procedure().controls.completeness!)
    expect(validateProcedureVersion({ ...procedure(), controls: { ...procedure().controls, completeness: inheritedControlFields } })).toContain('Incomplete required control: completeness')
  })

  it('rejects inherited document and change-log fields without invoking accessors', () => {
    expect(validateProcedureVersion(Object.create(procedure()))).toEqual(expect.arrayContaining(['Procedure document ID must be nonblank and stable.', 'Procedure effective boundaries are invalid or reversed.']))
    expect(() => createTenantProcedurePackage(Object.create(procedure()), tenant, '2026-06-01T00:00:00Z')).toThrow('effective boundaries')
    expect(validateProcedureVersion({ ...procedure(), changeLog: [Object.create(procedure().changeLog[0])] })).toContain('At least one well-formed change-log entry with date, actor and summary is required.')
    let reads = 0; const accessorDocument = { ...procedure() } as Record<string, unknown>; Object.defineProperty(accessorDocument, 'approvedAt', { enumerable: true, get: () => { reads += 1; return '2026-01-01T09:00:00Z' } })
    expect(() => createTenantProcedurePackage(accessorDocument as never, tenant, '2026-06-01T00:00:00Z')).toThrow('document approval'); expect(reads).toBe(0)
  })

  it('rejects hidden, inherited and accessor-backed effective end boundaries while allowing own undefined', () => {
    const hidden = procedure(); Object.defineProperty(hidden, 'effectiveTo', { value: '2026-01-31', enumerable: false })
    expect(validateProcedureVersion(hidden)).toContain('Procedure effective boundaries are invalid or reversed.'); expect(() => createTenantProcedurePackage(hidden, tenant, '2026-06-01T00:00:00Z')).toThrow('effective boundaries')
    const inherited = procedure(); Object.setPrototypeOf(inherited, { effectiveTo: '2026-01-31' })
    expect(validateProcedureVersion(inherited)).toContain('Procedure effective boundaries are invalid or reversed.')
    let reads = 0; const accessor = procedure(); Object.defineProperty(accessor, 'effectiveTo', { enumerable: true, get: () => { reads += 1; return '2026-01-31' } })
    expect(validateProcedureVersion(accessor)).toContain('Procedure effective boundaries are invalid or reversed.'); expect(reads).toBe(0)
    expect(validateProcedureVersion({ ...procedure(), effectiveTo: undefined })).not.toContain('Procedure effective boundaries are invalid or reversed.')
  })

  it('canonicalizes change-log and operator-role records before computing completeness and packaging', () => {
    const decorated = { ...procedure(), changeLog: [{ ...procedure().changeLog[0], ignoredChangeField: 'discard' }] }
    let roleReads = 0; const operatorRoles: Record<string, string> = {}; Object.defineProperty(operatorRoles, 'poster', { enumerable: true, get: () => { roleReads += 1; return 'Alice' } })
    const packageResult = createTenantProcedurePackage(decorated, { ...tenant, operatorRoles }, '2026-06-01T00:00:00Z')
    const content = JSON.parse(packageResult.content)
    expect(packageResult.warnings).toContain('Tenant operator roles require at least one nonblank role with an assigned operator.'); expect(content.completeness.complete).toBe(false); expect(content.operator.operatorRoles).toEqual({}); expect(roleReads).toBe(0)
    expect(content.product.changeLog[0]).toEqual({ changedAt: '2026-01-01', changedBy: 'Admin', summary: 'Created' })
  })

  it('captures historic tenant snapshot identity and details once without invoking accessors', () => {
    let reads = 0; const accessorSnapshot = { id: 'snapshot-1', effectiveFrom: '2026-01-01', details: tenant } as Record<string, unknown>; Object.defineProperty(accessorSnapshot, 'details', { enumerable: true, get: () => { reads += 1; return reads === 1 ? tenant : { ...tenant, tenantId: 'other' } } })
    expect(() => selectHistoricTenantProcedureSnapshot([accessorSnapshot as never], '2026-06-01T00:00:00Z')).toThrow('structured tenant state'); expect(reads).toBe(0)
    const selected = selectHistoricTenantProcedureSnapshot([{ id: 'snapshot-1', effectiveFrom: '2026-01-01', details: { ...tenant, operatorRoles: { ...tenant.operatorRoles, extra: 'Bob' } }, ignored: 'discard' } as never], '2026-06-01T00:00:00Z')
    expect(selected).not.toHaveProperty('ignored'); expect(selected.details).toEqual({ ...tenant, operatorRoles: { poster: 'Alice', extra: 'Bob' } })
  })

  it('rejects a non-array historic-version adapter with a controlled contract error', () => {
    expect(() => selectHistoricProcedure('not-an-array' as never, '2026-06-01T00:00:00Z')).toThrow('versions must be an array')
  })

  it('rejects a historic procedure history containing different document identities', () => {
    const first = { ...procedure(), effectiveTo: '2026-06-30' }
    const second = { ...procedure(), id: 'unrelated-procedure', version: '1.1.0', effectiveFrom: '2026-07-01' }
    expect(() => selectHistoricProcedure([first, second], '2026-08-01T00:00:00Z')).toThrow('one canonical nonblank document ID')
  })

  it('requires unique canonical versions within one historic procedure identity', () => {
    const first = { ...procedure(), effectiveTo: '2026-06-30' }
    const reused = { ...procedure(), effectiveFrom: '2026-07-01' }
    expect(() => selectHistoricProcedure([first, reused], '2026-08-01T00:00:00Z')).toThrow('unique canonical version identities')
    expect(() => selectHistoricProcedure([{ ...procedure(), version: ' 1.0.0 ' }], '2026-06-01T00:00:00Z')).toThrow('unique canonical version identities')
  })

  it('requires unique canonical IDs across historic tenant snapshots', () => {
    const first = { id: 'snapshot-1', effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30', details: tenant }
    const reused = { id: 'snapshot-1', effectiveFrom: '2026-07-01', details: { ...tenant, legalName: 'Renamed GmbH' } }
    expect(() => selectHistoricTenantProcedureSnapshot([first, reused], '2026-08-01T00:00:00Z')).toThrow('unique canonical nonblank IDs')
    expect(() => selectHistoricTenantProcedureSnapshot([{ id: ' snapshot-1 ', effectiveFrom: '2026-01-01', details: tenant }], '2026-06-01T00:00:00Z')).toThrow('unique canonical nonblank IDs')
  })

  it('uses indexed descriptor snapshots instead of caller-overridable array methods and iterators', () => {
    const invalidChangeLog = [{ changedAt: '', changedBy: '', summary: '' }]
    Object.defineProperty(invalidChangeLog, 'some', { value: () => false, configurable: true })
    expect(validateProcedureVersion({ ...procedure(), changeLog: invalidChangeLog })).toContain('At least one well-formed change-log entry with date, actor and summary is required.')
    expect(createTenantProcedurePackage({ ...procedure(), changeLog: invalidChangeLog }, tenant, '2026-06-01T00:00:00Z').warnings).toContain('At least one well-formed change-log entry with date, actor and summary is required.')

    const taxonomyVersions = ['6.10']; Object.defineProperty(taxonomyVersions, Symbol.iterator, { value: function* () { yield 'forged-taxonomy' }, configurable: true })
    const evidenceIndex = [...tenant.evidenceIndex]; Object.defineProperty(evidenceIndex, Symbol.iterator, { value: function* () { yield 'forged-evidence' }, configurable: true })
    const packaged = JSON.parse(createTenantProcedurePackage({ ...procedure(), taxonomyVersions }, { ...tenant, evidenceIndex }, '2026-06-01T00:00:00Z').content)
    expect(packaged.product.taxonomyVersions).toEqual(['6.10'])
    expect(packaged.operator.evidenceIndex).toEqual(tenant.evidenceIndex)
  })

  it('rejects malformed top-level procedure package inputs with controlled contract errors', () => {
    expect(() => createTenantProcedurePackage(null as never, tenant, '2026-06-01T00:00:00Z')).toThrow('Procedure document must be a structured object')
    expect(() => createTenantProcedurePackage(procedure(), undefined as never, '2026-06-01T00:00:00Z')).toThrow('Tenant procedure details must be a structured object')
  })
})
