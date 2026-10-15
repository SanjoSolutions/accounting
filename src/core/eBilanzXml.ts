import { SaxesParser, type SaxesTagNS } from 'saxes'

export const XMLNS = {
  xbrli: 'http://www.xbrl.org/2003/instance', xsd: 'http://www.w3.org/2001/XMLSchema',
  link: 'http://www.xbrl.org/2003/linkbase', xlink: 'http://www.w3.org/1999/xlink',
  xsi: 'http://www.w3.org/2001/XMLSchema-instance', xbrldi: 'http://xbrl.org/2006/xbrldi',
} as const

export interface XmlElement {
  local: string
  uri: string
  attributes: Record<string, string>
  namespaces: Record<string, string>
  children: XmlElement[]
  text: string
}

export function parseEBalanceXml(xml: string): XmlElement {
  const stack: XmlElement[] = []
  let root: XmlElement | undefined
  const parser = new SaxesParser({ xmlns: true })
  parser.on('doctype', () => { throw new Error('DOCTYPE is forbidden in reporting XML.') })
  parser.on('opentag', (tag: SaxesTagNS) => {
    const node: XmlElement = { local: tag.local, uri: tag.uri, attributes: {}, namespaces: { ...stack.at(-1)?.namespaces, ...tag.ns }, children: [], text: '' }
    for (const attr of Object.values(tag.attributes)) node.attributes[attr.uri ? `{${attr.uri}}${attr.local}` : attr.local] = attr.value
    if (stack.length) stack.at(-1)!.children.push(node)
    else root = node
    stack.push(node)
  })
  parser.on('text', text => { if (stack.length) stack.at(-1)!.text += text })
  parser.on('cdata', text => { if (stack.length) stack.at(-1)!.text += text })
  parser.on('closetag', () => { stack.pop() })
  parser.write(xml).close()
  if (!root) throw new Error('Reporting XML has no root element.')
  return root
}

export function xmlEscape(value: string) {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value) || /[\ud800-\udfff]/u.test(value)) throw new Error('Reporting text contains an invalid XML character.')
  return value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!)
}

export function xmlDescendants(node: XmlElement): XmlElement[] {
  return [node, ...node.children.flatMap(xmlDescendants)]
}

export function centsText(cents: number) {
  if (!Number.isSafeInteger(cents)) throw new Error('Amounts must be safe integer cents.')
  return `${cents < 0 ? '-' : ''}${Math.floor(Math.abs(cents) / 100)}.${String(Math.abs(cents) % 100).padStart(2, '0')}`
}
