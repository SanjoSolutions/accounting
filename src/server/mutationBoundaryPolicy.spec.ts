import { readdirSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { apiMutationBoundaryPolicy, serverActionBoundaryPolicy, sideEffectingReadBoundaryPolicy } from './mutationBoundaryPolicy'

const repositoryRoot = resolve(process.cwd())
const apiRoot = resolve(repositoryRoot, 'src/app/api')

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? filesBelow(resolve(directory, entry.name)) : [resolve(directory, entry.name)])
}

function apiBoundaries() {
  return filesBelow(apiRoot).filter(file => file.endsWith('route.ts')).flatMap(file => {
    const source = readFileSync(file, 'utf8')
    const route = `/api/${relative(apiRoot, file).replaceAll('\\', '/').replace(/\/route\.ts$/, '')}`
    return [...source.matchAll(/export (?:async )?function (POST|PUT|PATCH|DELETE)\b/g)].map(match => ({ key: `${route}#${match[1]}`, source, file }))
  })
}

function serverActionBoundaries() {
  return filesBelow(resolve(repositoryRoot, 'src')).filter(file => /\.(?:ts|tsx)$/.test(file)).flatMap(file => {
    const source = readFileSync(file, 'utf8')
    if (!/^['"]use server['"]/m.test(source)) return []
    const module = relative(repositoryRoot, file).replaceAll('\\', '/')
    return [...source.matchAll(/export async function (\w+)\b/g)].map(match => ({ key: `${module}#${match[1]}`, source, file }))
  })
}

function sideEffectingReads() {
  return filesBelow(apiRoot).filter(file => file.endsWith('route.ts')).flatMap(file => {
    const source = readFileSync(file, 'utf8'); const start = source.search(/export async function GET\b/)
    if (start < 0) return []
    const next = source.indexOf('export async function ', start + 24); const handler = source.slice(start, next < 0 ? undefined : next)
    if (!/\b(?:ensureLedger|reconcilePendingOutgoingInvoiceAccounting|downloadTenantBackupPayload|downloadReportingPackage)\s*\(/.test(handler)) return []
    const route = `/api/${relative(apiRoot, file).replaceAll('\\', '/').replace(/\/route\.ts$/, '')}`
    return [{ key: `${route}#GET`, source: handler }]
  })
}

describe('complete mutation-boundary authorization policy', () => {
  it('Given the application route tree, when non-GET handlers are inventoried, then every boundary has exactly one explicit central classification', () => {
    expect(apiBoundaries().map(item => item.key).sort()).toEqual(Object.keys(apiMutationBoundaryPolicy).sort())
  })

  it('Given a tenant mutation classification, when its source is inspected, then authentication and the exact role guard precede body parsing', () => {
    for (const boundary of apiBoundaries()) {
      const policy = apiMutationBoundaryPolicy[boundary.key as keyof typeof apiMutationBoundaryPolicy]
      if (policy !== 'write' && policy !== 'manage_access') continue
      expect(boundary.source, boundary.key).toContain('getCurrentUser(')
      const guard = `forbiddenUnless(user, '${policy}')`
      expect(boundary.source, boundary.key).toContain(guard)
      const guardIndex = boundary.source.indexOf(guard)
      const parseIndex = boundary.source.indexOf('request.json()')
      if (parseIndex >= 0) expect(guardIndex, `${boundary.key} must authorize before parsing mutation input`).toBeLessThan(parseIndex)
    }
  })

  it('Given exceptional non-tenant mutations, when inspected, then public auth and assigned-tenant selection remain narrowly classified', () => {
    const byKey = new Map(apiBoundaries().map(item => [item.key, item.source]))
    expect(byKey.get('/api/auth/[...all]#POST')).toContain('isCredentialAuthEnabled()')
    expect(byKey.get('/api/access/active-tenant#POST')).toContain('listAvailableTenants(user.actorId)')
    expect(byKey.get('/api/access/active-tenant#POST')).not.toContain("forbiddenUnless(user, 'manage_access')")
  })

  it('Given server actions, when their exported functions are inventoried, then every action is centrally classified and tenant mutation cannot hide there', () => {
    expect(serverActionBoundaries().map(item => item.key).sort()).toEqual(Object.keys(serverActionBoundaryPolicy).sort())
    expect(serverActionBoundaryPolicy['src/i18n/actions.ts#setLocale']).toBe('session_preference')
  })

  it('Given read handlers with maintenance or audit side effects, when inventoried, then they are explicit and read-only users cannot trigger maintenance writes', () => {
    const reads = sideEffectingReads(); expect(reads.map(item => item.key).sort()).toEqual(Object.keys(sideEffectingReadBoundaryPolicy).sort())
    for (const read of reads) {
      const policy = sideEffectingReadBoundaryPolicy[read.key as keyof typeof sideEffectingReadBoundaryPolicy]
      if (policy === 'conditional_maintenance') {
        expect(read.source, read.key).toMatch(/user\.role (?:!==|===) 'READ_ONLY'/)
      }
      if (policy === 'audited_read') expect(read.source, read.key).toContain('user.actorId')
    }
  })

  it('Given the role model, when policy values are reviewed, then only access membership administration is admin-only', () => {
    expect(Object.entries(apiMutationBoundaryPolicy).filter(([, policy]) => policy === 'manage_access').map(([key]) => key)).toEqual(['/api/access#POST'])
  })

  it('Given separate active-tenant and human identities, when mutation route sources are reviewed, then no route reuses the tenant ID as its audit actor argument', () => {
    for (const boundary of apiBoundaries()) expect(boundary.source, boundary.key).not.toMatch(/user\.id\s*,\s*user\.id/)
  })
})
