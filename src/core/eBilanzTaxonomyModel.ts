import { createHash } from 'node:crypto'
import { strFromU8, unzipSync } from 'fflate'
import type { OfficialEBalanceTaxonomy } from './eBilanzTaxonomy'
import { parseEBalanceXml, XMLNS, xmlDescendants } from './eBilanzXml'

export interface TaxonomyConcept {
  name: string; namespace: string; type: string; period: string; balance: string
  abstract: boolean; tuple: boolean; required: boolean; prohibited: boolean
}
export interface EBalanceTaxonomyModel {
  release: OfficialEBalanceTaxonomy
  concepts: Map<string, TaxonomyConcept>
  calculations: Map<string, Array<{ concept: string; weight: number }>>
}
const cache = new Map<string, EBalanceTaxonomyModel>()
const xlink = (name: string) => `{${XMLNS.xlink}}${name}`

export function readEBalanceTaxonomy(release: OfficialEBalanceTaxonomy, bytes: Uint8Array): EBalanceTaxonomyModel {
  const checksum = createHash('sha256').update(bytes).digest('hex')
  if (checksum !== release.archiveSha256) throw new Error('Official taxonomy archive checksum mismatch.')
  const identity = JSON.stringify(release)
  const cached = cache.get(identity)
  if (cached) return cached
  const files = unzipSync(bytes)
  if (!files[release.entryPoint] || !files[release.gcdEntryPoint]) throw new Error('Official taxonomy entry point is missing.')
  const concepts = new Map<string, TaxonomyConcept>()
  for (const [name, bytes] of Object.entries(files)) {
    if (!name.endsWith('.xsd')) continue
    const schema = parseEBalanceXml(strFromU8(bytes))
    const namespace = schema.attributes.targetNamespace
    if (![release.gaapNamespace, release.gcdNamespace].includes(namespace)) continue
    for (const element of schema.children.filter(node => node.uri === XMLNS.xsd && node.local === 'element')) {
      const attr = element.attributes
      const prefix = namespace === release.gaapNamespace ? 'gaap' : 'gcd'
      concepts.set(`${prefix}:${attr.name}`, {
        name: attr.name, namespace, type: attr.type ?? '', period: attr[`{${XMLNS.xbrli}}periodType`] ?? '',
        balance: attr[`{${XMLNS.xbrli}}balance`] ?? '', abstract: attr.abstract === 'true',
        tuple: attr.substitutionGroup === 'xbrli:tuple', required: false, prohibited: false,
      })
    }
  }
  for (const prefix of ['de-gaap-ci', 'de-gcd']) {
    const file = Object.keys(files).find(name => name.startsWith(`${prefix}-`) && name.endsWith('-reference-fiscal.xml') && !name.includes('-dimensions-'))!
    for (const ref of xmlDescendants(parseEBalanceXml(strFromU8(files[file]))).filter(node => node.local === 'reference')) {
      const name = ref.attributes.id?.replace(`reference_${prefix}_`, '')
      const concept = concepts.get(`${prefix === 'de-gcd' ? 'gcd' : 'gaap'}:${name}`)
      if (!concept) continue
      const parts = Object.fromEntries(ref.children.map(node => [node.local, node.text]))
      concept.prohibited = parts.notPermittedFor === 'steuerlich' || parts.onlyPermittedForSoBil_ErgBil === 'true'
        || parts.legalFormKSt === 'false' || parts.typeOperatingResult === 'UKV'
      concept.required = !concept.prohibited && parts.legalFormKSt === 'true' && /mussfeld/i.test(parts.fiscalRequirement ?? '')
    }
  }
  const calculations = new Map<string, Array<{ concept: string; weight: number }>>()
  for (const suffix of ['balanceSheet', 'incomeStatement']) {
    const file = Object.keys(files).find(name => name.startsWith('de-gaap-ci-') && name.endsWith(`-calculation-${suffix}.xml`))!
    const root = parseEBalanceXml(strFromU8(files[file]))
    for (const link of root.children.filter(node => node.local === 'calculationLink')) {
      const locators = new Map(link.children.filter(node => node.local === 'loc').map(node => [node.attributes[xlink('label')], node.attributes[xlink('href')].split('#de-gaap-ci_')[1]]))
      for (const arc of link.children.filter(node => node.local === 'calculationArc' && node.attributes.use !== 'prohibited')) {
        const parent = locators.get(arc.attributes[xlink('from')])!
        const concept = locators.get(arc.attributes[xlink('to')])!
        const children = calculations.get(parent) ?? []
        if (!children.some(child => child.concept === concept)) children.push({ concept, weight: Number(arc.attributes.weight) })
        calculations.set(parent, children)
      }
    }
  }
  const model = { release, concepts, calculations }
  cache.set(identity, model)
  return model
}

export function monetaryConcept(model: EBalanceTaxonomyModel, name: string) {
  const concept = model.concepts.get(`gaap:${name}`)
  if (!concept || concept.abstract || concept.tuple || concept.prohibited || concept.type !== 'xbrli:monetaryItemType') throw new Error(`Unsupported monetary taxonomy concept: ${name}.`)
  return concept
}

/** Apply official calculation weights. Never double-count a directly mapped subtotal. */
export function rollUpEBalanceFacts(model: EBalanceTaxonomyModel, direct: Map<string, number>) {
  const values = new Map(direct)
  const resolved = new Map<string, number | undefined>()
  const resolve = (name: string, ancestors = new Set<string>()): number | undefined => {
    if (resolved.has(name)) return resolved.get(name)
    if (ancestors.has(name)) throw new Error('Cyclic taxonomy calculation.')
    const next = new Set([...ancestors, name])
    const children = (model.calculations.get(name) ?? []).map(child => ({ ...child, amount: resolve(child.concept, next) }))
    const populated = children.filter(child => child.amount !== undefined)
    if (direct.has(name)) {
      if (populated.some(child => child.amount !== 0)) throw new Error(`Overlapping account mappings at subtotal ${name}.`)
      resolved.set(name, direct.get(name))
      return direct.get(name)
    }
    if (!populated.length) { resolved.set(name, undefined); return undefined }
    const amount = populated.reduce((sum, child) => sum + child.amount! * child.weight, 0)
    if (!Number.isSafeInteger(amount)) throw new Error('Taxonomy calculation exceeds safe integer cents.')
    values.set(name, amount)
    resolved.set(name, amount)
    return amount
  }
  for (const name of model.calculations.keys()) resolve(name)
  return values
}
