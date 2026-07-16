import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { AccountingValidationError } from './doubleEntry'

export function validateEBalanceConcepts(xml: string, officialTaxonomyArchive: Uint8Array) {
  const files = unzipSync(officialTaxonomyArchive)
  const declared = new Set<string>()
  for (const [name, contents] of Object.entries(files)) {
    if (!name.endsWith('.xsd')) continue
    collectGlobalSchemaElements(strFromU8(contents), declared)
  }
  if (declared.size === 0) throw new AccountingValidationError(['Das amtliche Taxonomiepaket enthält keine lesbaren XSD-Konzepte.'])
  const used = collectTaxonomyElements(xml)
  const unknown = [...new Set(used.filter(concept => !declared.has(`${concept.namespace}\0${concept.name}`)).map(concept => concept.name))]
  if (unknown.length) throw new AccountingValidationError([`Der E-Bilanz-Entwurf verwendet nicht in Taxonomie 6.9 enthaltene Konzepte: ${unknown.join(', ')}.`])
}

function collectGlobalSchemaElements(schema: string, declared: Set<string>) {
  let depth = 0
  let targetNamespace = ''
  const withoutComments = schema.replace(/<!--[\s\S]*?-->/g, '')
  for (const match of withoutComments.matchAll(/<\/?[A-Za-z_][A-Za-z0-9_.:-]*\b[^>]*>/g)) {
    const token = match[0]
    const closing = token.startsWith('</')
    if (closing) { depth--; continue }
    const qualifiedName = token.match(/^<([A-Za-z_][A-Za-z0-9_.:-]*)/)?.[1] ?? ''
    const localName = qualifiedName.split(':').at(-1)
    if (localName === 'schema' && depth === 0) targetNamespace = attribute(token, 'targetNamespace') ?? ''
    if (localName === 'element' && depth === 1 && targetNamespace) {
      const name = attribute(token, 'name')
      if (name) declared.add(`${targetNamespace}\0${name}`)
    }
    if (!token.endsWith('/>')) depth++
  }
}

function collectTaxonomyElements(xml: string) {
  const root = xml.match(/<xbrli:xbrl\b[^>]*>/)?.[0]
  if (!root) throw new AccountingValidationError(['Der E-Bilanz-Entwurf enthält kein XBRL-Wurzelelement.'])
  const namespaces = new Map<string, string>()
  for (const declaration of root.matchAll(/\bxmlns(?::([A-Za-z_][A-Za-z0-9_.-]*))?\s*=\s*(["'])([^"']+)\2/g)) {
    namespaces.set(declaration[1] ?? '', declaration[3])
  }
  const used: Array<{ namespace: string; name: string }> = []
  for (const match of xml.matchAll(/<([A-Za-z_][A-Za-z0-9_.:-]*)\b[^>]*>/g)) {
    const [prefix = '', name] = match[1].includes(':') ? match[1].split(':', 2) : ['', match[1]]
    const namespace = namespaces.get(prefix) ?? ''
    if (namespace.startsWith('http://www.xbrl.de/taxonomies/de-gaap-ci-') || namespace.startsWith('http://www.xbrl.de/taxonomies/de-gcd-')) used.push({ namespace, name })
  }
  return used
}

function attribute(token: string, name: string) {
  const match = token.match(new RegExp(`\\b${name}\\s*=\\s*(["'])([^"']+)\\1`))
  return match?.[2]
}

export function createEBalancePackage(xml: string, year: number, officialTaxonomyArchive: Uint8Array) {
  return zipSync({
    ...unzipSync(officialTaxonomyArchive),
    [`e-bilanz-${year}.xbrl`]: strToU8(xml),
  }, { level: 6 })
}
