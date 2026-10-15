import { describe, expect, test } from 'vitest'
import { documentSearchTerms, matchDocumentSearch, normalizeDocumentSearch } from './documentSearch'

describe('document search matching', () => {
  test('Given different casing and Unicode forms, when matching, then accents, sharp s and whitespace are normalized', () => {
    expect(normalizeDocumentSearch('  BÜRO\nStraße  Café ')).toBe('buro strasse cafe')
    expect(matchDocumentSearch('Büro.pdf', 'Straße Café', documentSearchTerms('BURO strasse CAFE'))).toMatchObject({ score: 1 })
  })
  test('Given multiple terms, when searching, then every term must occur in the filename or content', () => {
    expect(matchDocumentSearch('Acme.pdf', 'Invoice 47291', ['acme', '47291'])).not.toBeNull()
    expect(matchDocumentSearch('Acme.pdf', 'Invoice 47291', ['missing', '47291'])).toBeNull()
  })
  test('Given SQL or wildcard punctuation, when searching, then it is treated as literal text', () => {
    expect(matchDocumentSearch('invoice.pdf', 'anything', ['%'])).toBeNull()
    expect(matchDocumentSearch('100%.pdf', 'anything', ['%'])).not.toBeNull()
    expect(documentSearchTerms("  x x  ' OR 1=1 ")).toEqual(['x', "'", 'or', '1=1'])
  })
  test('Given empty or overlong input, when searching, then blank input lists documents and overlong input is rejected', () => {
    expect(matchDocumentSearch('a.pdf', '', documentSearchTerms('   '))).toEqual({ score: 0, snippet: null })
    expect(() => documentSearchTerms('a'.repeat(201))).toThrow(RangeError)
  })
  test('Given a long document, when a content term matches, then a bounded plain-text excerpt surrounds it', () => {
    const result = matchDocumentSearch('a.pdf', 'before '.repeat(60) + '<script>needle</script>' + ' after'.repeat(60), ['needle'])!
    expect(result.snippet).toContain('needle')
    expect(result.snippet!.length).toBeLessThanOrEqual(182)
    expect(result.snippet).toMatch(/^….*…$/)
  })
})
