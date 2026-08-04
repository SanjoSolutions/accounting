import { createHash } from 'node:crypto'
import { SaxesParser, type SaxesTagNS } from 'saxes'

const reportNamespace = 'http://www.xoev.de/de/validator/varl/1'
const scenarioNamespace = 'http://www.xoev.de/de/validator/framework/1/scenarios'

interface ParsedKositReport {
  reportValid?: string
  engineName: string
  scenarioName: string
  hashAlgorithm: string
  hashValue: string
  validationSteps: string[]
  accepts: number
  rejects: number
}

function attribute(tag: SaxesTagNS, name: string) {
  const value = tag.attributes[name]
  return typeof value === 'object' ? value.value : value
}

export function parseKositValidationReport(xml: string): ParsedKositReport {
  const result: ParsedKositReport = { engineName: '', scenarioName: '', hashAlgorithm: '', hashValue: '', validationSteps: [], accepts: 0, rejects: 0 }
  const stack: Array<{ local: string; uri: string }> = []
  let text = ''
  let rootSeen = false
  const parser = new SaxesParser({ xmlns: true })
  parser.on('opentag', tag => {
    if (!rootSeen) {
      if (tag.local !== 'report' || tag.uri !== reportNamespace) throw new Error('KoSIT output is not a VARL validation report.')
      rootSeen = true
      result.reportValid = attribute(tag, 'valid')
    }
    stack.push({ local: tag.local, uri: tag.uri })
    text = ''
    if (tag.uri === reportNamespace && tag.local === 'validationStepResult') result.validationSteps.push(String(attribute(tag, 'valid') ?? ''))
    if (tag.uri === reportNamespace && tag.local === 'accept' && stack.at(-2)?.local === 'assessment') result.accepts += 1
    if (tag.uri === reportNamespace && tag.local === 'reject' && stack.at(-2)?.local === 'assessment') result.rejects += 1
  })
  parser.on('text', value => { text += value })
  parser.on('closetag', tag => {
    const value = text.trim()
    const parent = stack.at(-2)
    if (tag.uri === reportNamespace && tag.local === 'name' && parent?.local === 'engine') result.engineName = value
    if (tag.uri === scenarioNamespace && tag.local === 'name' && parent?.local === 'scenario') result.scenarioName = value
    if (tag.uri === reportNamespace && tag.local === 'hashAlgorithm') result.hashAlgorithm = value
    if (tag.uri === reportNamespace && tag.local === 'hashValue') result.hashValue = value
    stack.pop()
    text = ''
  })
  parser.write(xml).close()
  if (!rootSeen) throw new Error('KoSIT output is empty.')
  return result
}

function assertBoundReport(report: ParsedKositReport, invoice: string | Uint8Array) {
  if (report.engineName !== 'KoSIT Validator 1.6.2') throw new Error('The report was not produced by the pinned KoSIT Validator 1.6.2 engine.')
  if (report.scenarioName !== 'EN16931 XRechnung (UBL Invoice)') throw new Error('The report did not match the exact XRechnung UBL Invoice scenario.')
  if (report.hashAlgorithm !== 'SHA-256') throw new Error('The report does not bind the validated document with SHA-256.')
  const expectedHash = createHash('sha256').update(invoice).digest('base64')
  if (report.hashValue !== expectedHash) throw new Error('The report document digest does not match the generated invoice bytes.')
  if (report.validationSteps.length < 3) throw new Error('The report does not contain the complete KoSIT validation pipeline.')
  return report
}

export function assertKositXRechnungAcceptance(xml: string, invoice: string | Uint8Array) {
  const report = assertBoundReport(parseKositValidationReport(xml), invoice)
  if (report.reportValid !== 'true' || report.accepts !== 1 || report.rejects !== 0 || report.validationSteps.some(valid => valid !== 'true')) throw new Error('KoSIT did not explicitly accept the XRechnung through every validation step.')
  return report
}

export function assertKositXRechnungRejection(xml: string, invoice: string | Uint8Array) {
  const report = assertBoundReport(parseKositValidationReport(xml), invoice)
  if (report.reportValid !== 'false' || report.accepts !== 0 || report.rejects !== 1 || report.validationSteps.every(valid => valid === 'true')) throw new Error('KoSIT did not explicitly reject the invalid XRechnung.')
  return report
}
