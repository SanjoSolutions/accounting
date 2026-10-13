import { describe, expect, test, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { assertSameOrigin, externalDownload, externalEvidenceForm, externalYear } from './http'

describe('External export HTTP boundaries', () => {
  test('Given retained bytes, when downloaded, then caching and active rendering are prohibited and the exact hash is returned', async () => {
    const response = externalDownload({ content: new Uint8Array([1, 2]), fileName: 'report.xbrl', contentHash: 'a'.repeat(64), packageHash: 'b'.repeat(64), sourceStatus: 'STALE' })
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="report.xbrl"')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-package-sha256')).toBe('b'.repeat(64))
    expect(response.headers.get('x-export-source-status')).toBe('STALE')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2]))
  })
  test('Given an invalid year or cross-origin mutation, when parsed, then it is rejected', () => {
    expect(() => externalYear('2026oops')).toThrow()
    expect(() => assertSameOrigin(new Request('http://127.0.0.1:3112/api', { headers: { origin: 'https://example.test' } }))).toThrow()
    expect(() => assertSameOrigin(new Request('http://127.0.0.1:3112/api', { headers: { origin: 'http://127.0.0.1:3112' } }))).not.toThrow()
  })
  test('Given a multipart receipt, when parsed, then its exact bytes and explicit hash binding are preserved', async () => {
    const form = new FormData()
    form.set('file', new File([new Uint8Array([0, 255, 1])], 'receipt.bin'))
    form.set('packageHash', 'a'.repeat(64)); form.set('confirmSource', 'true'); form.set('kind', 'TRANSMISSION')
    const result = await externalEvidenceForm(new Request('http://127.0.0.1:3112/api', { method: 'POST', body: form }))
    expect(result).toMatchObject({ fileName: 'receipt.bin', confirmSource: true, packageHash: 'a'.repeat(64), bytes: new Uint8Array([0, 255, 1]) })
  })
  test('Given an oversized declared or streamed body, when reading, then it is rejected before multipart parsing', async () => {
    await expect(externalEvidenceForm(new Request('http://127.0.0.1:3112/api', { method: 'POST', headers: { 'content-length': '999999999' }, body: 'x' }))).rejects.toThrow(/groß/)
    await expect(externalEvidenceForm(new Request('http://127.0.0.1:3112/api', { method: 'POST', body: new Uint8Array(6 * 1024 * 1024) }))).rejects.toThrow(/groß/)
  })
})
