import { describe, expect, it } from 'vitest'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { createEBalancePackage, validateEBalanceConcepts } from './eBilanzPackage'

describe('E-Bilanz validation package', () => {
  it('places the instance beside the complete resolvable taxonomy tree', () => {
    const taxonomy = zipSync({ 'de-gaap-ci-2025-04-01/de-gaap-ci-2025-04-01-shell-fiscal.xsd': strToU8('<schema/>') })
    const files = unzipSync(createEBalancePackage('<xbrli:xbrl/>', 2026, taxonomy))
    expect(Object.keys(files)).toContain('e-bilanz-2026.xbrl')
    expect(Object.keys(files)).toContain('de-gaap-ci-2025-04-01/de-gaap-ci-2025-04-01-shell-fiscal.xsd')
  })

  it('rejects undeclared report concepts against the packaged XSDs', () => {
    const namespace = 'http://www.xbrl.de/taxonomies/de-gaap-ci-2025-04-01'
    const taxonomy = zipSync({ 'gaap.xsd': strToU8(`<xsd:schema targetNamespace="${namespace}"><xsd:element id='asset' abstract='false' name='bs.ass'/></xsd:schema>`) })
    const instance = (fact: string) => `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:gaap="${namespace}">${fact}</xbrli:xbrl>`
    expect(() => validateEBalanceConcepts(instance('<gaap:bs.ass/><gaap:notDeclared/>'), taxonomy)).toThrow('nicht in Taxonomie 6.9 enthaltene Konzepte')
    expect(() => validateEBalanceConcepts(instance('<gaap:bs.ass/>'), taxonomy)).not.toThrow()
  })

  it('does not confuse equal local names from different taxonomy namespaces', () => {
    const gaap = 'http://www.xbrl.de/taxonomies/de-gaap-ci-2025-04-01'; const gcd = 'http://www.xbrl.de/taxonomies/de-gcd-2025-04-01'
    const taxonomy = zipSync({ 'gcd.xsd': strToU8(`<schema targetNamespace="${gcd}"><element name="onlyGcd"/></schema>`) })
    const xml = `<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:g="${gaap}"><g:onlyGcd/></xbrli:xbrl>`
    expect(() => validateEBalanceConcepts(xml, taxonomy)).toThrow('onlyGcd')
  })
})
