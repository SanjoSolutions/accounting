import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { strFromU8, strToU8, unzipSync } from 'fflate'
import { eBalanceChecksum, type EBalanceExportDataset } from '@/core/eBilanzExport'
import { readEBalanceTaxonomy, type EBalanceTaxonomyModel } from '@/core/eBilanzTaxonomyModel'
import { parseEBalanceXml, XMLNS, xmlDescendants } from '@/core/eBilanzXml'
import { serializeEBalanceFilingXml } from '@/core/eBilanzFilingXml'
import { canonicalJson } from '@/core/compliance/auditExport'

const BASE_ARCHIVE_SHA256 = '0e66514fafcc70b61a48d84c0744c8d90cab848bea41e8fd0a363c043c3465f2'
const BASE = 'https://offline-taxonomy.invalid/'

/** XSD validation of the official declaration closure used by this instance,
 * followed by XBRL context and supported mandatory-fact checks.
 * No network, entity expansion, ERiC invocation, transmission or acceptance claim.
 */
export async function validateEBalanceFilingXml(xml: string, dataset: EBalanceExportDataset, officialArchive: Uint8Array) {
  const model = readEBalanceTaxonomy(dataset.taxonomy, officialArchive)
  validateEBalanceInstanceStructure(xml, dataset, model)
  const lib = await import('libxml2-wasm')
  const [baseBytes, manifestText] = await Promise.all([
    readFile(path.join(process.cwd(), 'public/taxonomies/xbrl-base-schemas.zip')),
    readFile(path.join(process.cwd(), 'public/taxonomies/xbrl-base-schemas.json'), 'utf8'),
  ])
  if (eBalanceChecksum(baseBytes) !== BASE_ARCHIVE_SHA256) throw new Error('Pinned XBRL base schema checksum mismatch.')
  const baseFiles = unzipSync(baseBytes)
  const buffers: Record<string, Uint8Array> = {}
  for (const row of JSON.parse(manifestText) as Array<{ url: string; file: string; sha256: string }>) {
    if (!baseFiles[row.file] || eBalanceChecksum(baseFiles[row.file]) !== row.sha256) throw new Error('Pinned base schema manifest mismatch.')
    buffers[row.url] = baseFiles[row.file]
  }
  const archiveFiles = unzipSync(officialArchive)
  const declarations = new Map<string, ReturnType<typeof parseEBalanceXml>>()
  const schemas = new Map<string, ReturnType<typeof parseEBalanceXml>>()
  for (const [name, contents] of Object.entries(archiveFiles)) if (name.endsWith('.xsd')) {
    const schema = parseEBalanceXml(strFromU8(contents))
    if ([dataset.taxonomy.gaapNamespace, dataset.taxonomy.gcdNamespace].includes(schema.attributes.targetNamespace)) {
      schemas.set(name, schema)
      for (const node of schema.children.filter(node => node.local === 'element')) declarations.set(`${schema.attributes.targetNamespace}:${node.attributes.name}`, node)
    }
  }
  // Removing unreferenced global element declarations restricts (never broadens)
  // the schema language. Keep each used declaration and its complete ref and
  // substitution-head closure unchanged. This avoids libxml2's exponential
  // compilation of thousands of unrelated tuple substitution alternatives.
  const needed = new Set(xmlDescendants(parseEBalanceXml(xml)).map(node => `${node.uri}:${node.local}`))
  for (const node of xmlDescendants(parseEBalanceXml(xml))) {
    for (const value of [node.attributes.dimension, node.text].filter(value => /^de-gaap-ci:[A-Za-z_][\w.-]*$/.test(value ?? ''))) needed.add(`${dataset.taxonomy.gaapNamespace}:${value.split(':')[1]}`)
  }
  for (const key of needed) {
    const declaration = declarations.get(key)
    if (!declaration) continue
    for (const node of xmlDescendants(declaration)) {
      for (const value of [node.attributes.ref, node.attributes.substitutionGroup].filter(Boolean)) {
        const [prefix, local] = value.split(':')
        needed.add(`${node.namespaces[prefix]}:${local}`)
      }
    }
  }
  for (const [name, contents] of Object.entries(archiveFiles)) if (name.endsWith('.xsd')) {
    const schema = schemas.get(name)
    if (!schema) { buffers[`${BASE}${name}`] = contents; continue }
    const document = lib.XmlDocument.fromBuffer(contents)
    try {
      for (const node of document.find('/xs:schema/xs:element', { xs: XMLNS.xsd })) {
        const elementName = node.get('@name')!.content
        if (!needed.has(`${schema.attributes.targetNamespace}:${elementName}`)) node.remove()
      }
      buffers[`${BASE}${name}`] = strToU8(document.toString())
    } finally { document.dispose() }
  }
  const wrapper = `<xs:schema xmlns:xs="${XMLNS.xsd}"><xs:import namespace="${dataset.taxonomy.gaapNamespace}/shell-fiscal" schemaLocation="${BASE}${dataset.taxonomy.entryPoint}"/><xs:import namespace="${dataset.taxonomy.gcdNamespace}/shell" schemaLocation="${BASE}${dataset.taxonomy.gcdEntryPoint}"/><xs:import namespace="${XMLNS.xbrldi}" schemaLocation="http://www.xbrl.org/2006/xbrldi-2006.xsd"/></xs:schema>`
  // Registration and validation are synchronous after the import/read awaits.
  // No other request can interleave a different provider in this interval.
  const provider = new lib.XmlBufferInputProvider(buffers)
  lib.xmlRegisterInputProvider(provider)
  let schema: InstanceType<typeof lib.XmlDocument> | undefined
  let instance: InstanceType<typeof lib.XmlDocument> | undefined
  let validator: InstanceType<typeof lib.XsdValidator> | undefined
  try {
    schema = lib.XmlDocument.fromString(wrapper, { url: `${BASE}validation.xsd`, option: lib.ParseOption.XML_PARSE_NONET | lib.ParseOption.XML_PARSE_NO_XXE })
    validator = lib.XsdValidator.fromDoc(schema)
    instance = lib.XmlDocument.fromString(xml, { option: lib.ParseOption.XML_PARSE_NONET | lib.ParseOption.XML_PARSE_NO_XXE })
    validator.validate(instance)
  } catch (error) {
    const detail = error && typeof error === 'object' && 'details' in error ? JSON.stringify(error.details) : String(error)
    throw new Error(`Official taxonomy XSD validation failed: ${detail}`)
  } finally { validator?.dispose(); instance?.dispose(); schema?.dispose(); lib.xmlCleanupInputProvider() }
  if (xml !== serializeEBalanceFilingXml(dataset) && xml !== serializeEBalanceFilingXml(dataset, true)) throw new Error('Filing XML does not represent the exact immutable dataset.')
  const reportChecksum = eBalanceChecksum(xml)
  return { level: 'LOCAL_STRUCTURAL' as const, valid: true, officialAcceptance: 'NOT_VALIDATED' as const,
    closeGenerationId: dataset.closeGenerationId, reportChecksum, reconciliationChecksum: dataset.reconciliation.checksum,
    datasetChecksum: eBalanceChecksum(canonicalJson(dataset)), sourceChecksum: dataset.sourceChecksum,
    taxonomyArchiveSha256: dataset.taxonomy.archiveSha256, engine: 'libxml2-wasm@0.7.1',
    checks: ['OFFICIAL_ARCHIVE_SHA256', 'XML_NAMESPACES', 'OFFICIAL_XSD_DECLARATION_CLOSURE', 'XBRL_CONTEXTS_UNITS', 'SUPPORTED_REQUIRED_FACTS', 'ACCOUNT_TAX_ASSET_RECONCILIATION'] }
}

export function validateEBalanceInstanceStructure(xml: string, dataset: EBalanceExportDataset, model: EBalanceTaxonomyModel) {
  const root = parseEBalanceXml(xml)
  if (root.uri !== XMLNS.xbrli || root.local !== 'xbrl') throw new Error('Official filing XML requires the XBRL instance root.')
  const nodes = xmlDescendants(root)
  for (const node of nodes) {
    if (!['http://www.w3.org/2000/xmlns/', ...Object.values(XMLNS), dataset.taxonomy.gaapNamespace, dataset.taxonomy.gcdNamespace].includes(node.uri)) throw new Error(`Non-filing namespace in report: ${node.uri}.`)
    if (node.attributes['{http://www.w3.org/XML/1998/namespace}base']) throw new Error('xml:base is forbidden in filing XML.')
  }
  const contexts = new Map(root.children.filter(node => node.uri === XMLNS.xbrli && node.local === 'context').map(node => [node.attributes.id, node]))
  if (contexts.size !== root.children.filter(node => node.local === 'context').length) throw new Error('Duplicate XBRL contexts.')
  const factKeys = new Set<string>()
  for (const node of nodes.filter(node => [dataset.taxonomy.gaapNamespace, dataset.taxonomy.gcdNamespace].includes(node.uri))) {
    const prefix = node.uri === dataset.taxonomy.gaapNamespace ? 'gaap' : 'gcd'
    const concept = model.concepts.get(`${prefix}:${node.local}`)
    if (!concept || concept.abstract || concept.prohibited) throw new Error(`Unknown, abstract or prohibited taxonomy concept: ${node.local}.`)
    if (concept.tuple) continue
    const context = contexts.get(node.attributes.contextRef)
    if (!context) throw new Error(`Missing context for ${node.local}.`)
    const period = context.children.find(child => child.local === 'period')!
    if (!period || (concept.period === 'instant') !== period.children.some(child => child.local === 'instant')) throw new Error(`Incorrect XBRL period type for ${node.local}.`)
    const contextNodes = xmlDescendants(context)
    const identifier = contextNodes.find(child => child.local === 'identifier')
    if (identifier?.text !== dataset.company.taxNumber || identifier.attributes.scheme !== 'http://www.rzf-nrw.de/Steuernummer') throw new Error('XBRL context entity does not match the company.')
    if (contextNodes.find(child => child.local === 'instant')?.text !== undefined) {
      if (contextNodes.find(child => child.local === 'instant')!.text !== dataset.fiscalYear.endsAt) throw new Error('XBRL instant is not the exact fiscal closing date.')
    } else if (contextNodes.find(child => child.local === 'startDate')?.text !== dataset.fiscalYear.startsAt || contextNodes.find(child => child.local === 'endDate')?.text !== dataset.fiscalYear.endsAt) throw new Error('XBRL duration is not the exact fiscal period.')
    if (concept.type === 'xbrli:monetaryItemType' && (node.attributes.unitRef !== 'EUR' || node.attributes.decimals !== '2')) throw new Error('Monetary filing facts require EUR and exact cent precision.')
    if (root.children.includes(node)) {
      const key = `${node.uri}:${node.local}:${node.attributes.contextRef}`
      if (factKeys.has(key)) throw new Error('Duplicate filing fact.')
      factKeys.add(key)
    }
  }
  const declared = new Set(nodes.map(node => `${node.uri}:${node.local}`))
  for (const concept of model.concepts.values()) {
    if (!concept.required || concept.abstract || concept.prohibited) continue
    const supported = concept.namespace === dataset.taxonomy.gcdNamespace || /^(bs\.|is\.|BVV\.)/.test(concept.name)
    if (supported && !declared.has(`${concept.namespace}:${concept.name}`)) throw new Error(`Missing required taxonomy fact: ${concept.name}.`)
  }
  const units = root.children.filter(node => node.uri === XMLNS.xbrli && node.local === 'unit')
  if (units.length !== 1 || units[0].attributes.id !== 'EUR' || units[0].children[0]?.text !== 'iso4217:EUR' || units[0].children[0]?.namespaces.iso4217 !== 'http://www.xbrl.org/2003/iso4217') throw new Error('Invalid EUR unit.')
}
