import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertKositXRechnungAcceptance, assertKositXRechnungRejection } from './kositValidationReport'

const ns = 'http://www.xoev.de/de/validator/varl/1'
const scenarioNs = 'http://www.xoev.de/de/validator/framework/1/scenarios'
const report = (invoice: string, valid: boolean) => `<rep:report xmlns:rep="${ns}" xmlns:s="${scenarioNs}" valid="${valid}"><rep:engine><rep:name>KoSIT Validator 1.6.2</rep:name></rep:engine><rep:documentIdentification><rep:documentHash><rep:hashAlgorithm>SHA-256</rep:hashAlgorithm><rep:hashValue>${createHash('sha256').update(invoice).digest('base64')}</rep:hashValue></rep:documentHash></rep:documentIdentification><rep:scenarioMatched><s:scenario><s:name>EN16931 XRechnung (UBL Invoice)</s:name></s:scenario><rep:validationStepResult valid="true"/><rep:validationStepResult valid="true"/><rep:validationStepResult valid="${valid}"/></rep:scenarioMatched><rep:assessment><rep:${valid ? 'accept' : 'reject'}/></rep:assessment></rep:report>`

describe('KoSIT XRechnung report semantics', () => {
  it('Given CI downloads official KoSIT artifacts, when supply-chain controls are inspected, then exact release URLs and independently recorded SHA-256 digests are mandatory', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/quality.yml'), 'utf8')
    expect(workflow).toContain('validator/releases/download/v1.6.2/validator-1.6.2-standalone.jar')
    expect(workflow).toContain('validator-configuration-xrechnung/releases/download/v2026-01-31/xrechnung-3.0.2-validator-configuration-2026-01-31.zip')
    expect(workflow).toContain('244978514ad48f67c7573acfffc8f4fd73d81feda6f276710033f9913579857e  validator.jar')
    expect(workflow).toContain('6a5a5911a421b25fbc423f62f93f894df7b236f5d73ca4f84bb222a945082704  xrechnung.zip')
    expect(workflow.match(/sha256sum --check --strict/g)).toHaveLength(2)
  })

  it('Given a report bound to exact invoice bytes, when every official success marker is present, then acceptance is proven', () => {
    expect(assertKositXRechnungAcceptance(report('invoice', true), 'invoice')).toMatchObject({ reportValid: 'true', accepts: 1, rejects: 0 })
  })

  it('Given ambiguous, incomplete, or differently bound output, when acceptance is asserted, then it fails closed', () => {
    expect(() => assertKositXRechnungAcceptance(report('other', true), 'invoice')).toThrow(/digest/)
    expect(() => assertKositXRechnungAcceptance(report('invoice', false), 'invoice')).toThrow(/did not explicitly accept/)
    expect(() => assertKositXRechnungAcceptance(report('invoice', true).replace('KoSIT Validator 1.6.2', 'unknown'), 'invoice')).toThrow(/pinned KoSIT/)
  })

  it('Given an invalid invoice and its exact official rejection markers, when rejection is asserted, then rejection is proven rather than inferred from process exit', () => {
    expect(assertKositXRechnungRejection(report('invalid', false), 'invalid')).toMatchObject({ reportValid: 'false', accepts: 0, rejects: 1 })
  })
})
