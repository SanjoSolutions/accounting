import { createHash } from 'node:crypto'
import { canonicalJson } from './auditExport'
import { MICRO_BALANCE_SHEET_ORDER, SMALL_BALANCE_SHEET_ORDER, prepareAnnualAccounts, type AnnualAccountsPackage, type AnnualAccountLine, type AnnualPackageInput } from './annualAccounts'
import { readRecordedAnnualAppropriation } from './annualDocumentAppropriation'

export const ANNUAL_DOCUMENT_RENDERER = 'hgb-print-2'
export type AnnualDocumentMode = 'annual' | 'manual'
export interface AnnualDocumentSource {
  packageId: string; packageVersion: number; packageChecksum: string
  annual: AnnualAccountsPackage; input: AnnualPackageInput
  approvedBy: string; approvedAt: string
  close: { id: string; checksum: string; notesRequired: boolean; signatures: { representativeId: string; signedAt: string; signatureEvidenceId: string }[]; resolutionId: string }
  equity: { resultCents: number; shareCapitalCents: number; section5aReserveApplicable: boolean; reserveCalculationEvidenceId?: string; evidenceId: string }
}
export interface DisclosureSelection {
  noteIndexes: number[]; policyIndexes: number[]
  establishedOn: string
  confirmedCompleteAndMinimized: true
}

export const hashDocument = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
export function euroCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error('Unsafe monetary amount')
  const value = BigInt(cents); const magnitude = value < BigInt(0) ? -value : value
  return `${value < BigInt(0) ? '−' : ''}${(magnitude / BigInt(100)).toLocaleString('de-DE')},${String(magnitude % BigInt(100)).padStart(2, '0')}`
}

/** Re-run the domain's reconciliation and canonical DTO checks, never a ledger calculation. */
export function readAnnualDocumentInput(annual: AnnualAccountsPackage): AnnualPackageInput {
  const { supersedesId, ...input } = JSON.parse(annual.immutablePayload) as AnnualPackageInput & { supersedesId?: string }
  const expected = prepareAnnualAccounts(input, annual.version, supersedesId)
  if (expected.id !== annual.id || expected.checksum !== annual.checksum || expected.immutablePayload !== annual.immutablePayload || expected.supersedesId !== annual.supersedesId) throw new Error('Annual statement identity or checksum is invalid')
  return input
}

export function selectDisclosure(source: AnnualDocumentSource, selection: DisclosureSelection) {
  if (!['MICRO', 'SMALL'].includes(source.input.profile.size) || !['UG', 'GMBH'].includes(source.input.profile.legalForm)) throw new Error('Manual disclosure supports MICRO/SMALL UG/GmbH only')
  if (source.input.profile.size === 'MICRO' && source.close.notesRequired) throw new Error('Manual micro disclosure requires the evidenced below-balance-sheet notes exemption')
  if (selection?.confirmedCompleteAndMinimized !== true) throw new Error('Confirm complete required disclosures and removal of private or GuV-only content')
  if (typeof selection.establishedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(selection.establishedOn) || !Number.isFinite(Date.parse(`${selection.establishedOn}T00:00:00Z`)) || new Date(`${selection.establishedOn}T00:00:00Z`).toISOString().slice(0, 10) !== selection.establishedOn || selection.establishedOn < source.input.preparedAt.slice(0, 10)) throw new Error('A real establishment date from the shareholder resolution, on or after preparation, is required')
  const choose = (indexes: number[], values: readonly string[]) => {
    if (!Array.isArray(indexes) || new Set(indexes).size !== indexes.length || indexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= values.length)) throw new Error('Disclosure selection is invalid')
    return indexes.slice().sort((a, b) => a - b).map(index => values[index])
  }
  const notes = choose(selection.noteIndexes, source.input.notes)
  const policies = choose(selection.policyIndexes, source.input.policies)
  if (!notes.length || notes.some(note => note.includes('Anhangangaben werden aufgrund der dokumentierten Kleinstkapitalgesellschaft-Erleichterung'))) throw new Error('Actual approved disclosure text is required; an exemption placeholder is insufficient. Prepare and approve a corrected annual package with the required notes.')
  if (source.input.profile.size === 'MICRO' && policies.length) throw new Error('Micro deposit excludes internal policy workpapers')
  if (source.input.profile.size === 'SMALL' && !policies.length) throw new Error('Select the applicable approved accounting policies for the small-company notes')
  return { notes, policies }
}

const labels: Record<string, string> = {
  'A.ASSETS': 'Summe Aktiva', 'A.FIXED': 'Anlagevermögen', 'A.INTANGIBLE': 'Immaterielle Vermögensgegenstände', 'A.TANGIBLE': 'Sachanlagen', 'A.FINANCIAL': 'Finanzanlagen', 'A.CURRENT': 'Umlaufvermögen', 'A.INVENTORIES': 'Vorräte', 'A.RECEIVABLES': 'Forderungen und sonstige Vermögensgegenstände', 'A.SECURITIES': 'Wertpapiere', 'A.CASH': 'Kassenbestand und Guthaben bei Kreditinstituten', 'A.PREPAID': 'Rechnungsabgrenzungsposten', 'A.DEFERRED_TAX': 'Aktive latente Steuern', 'A.PENSION_DIFFERENCE': 'Aktiver Unterschiedsbetrag aus der Vermögensverrechnung',
  'B.EQUITY_LIABILITIES': 'Summe Passiva', 'B.EQUITY': 'Eigenkapital', 'B.SUBSCRIBED_CAPITAL': 'Gezeichnetes Kapital', 'B.CAPITAL_RESERVE': 'Kapitalrücklage', 'B.REVENUE_RESERVES': 'Gewinnrücklagen', 'B.CARRYFORWARD': 'Gewinnvortrag / Verlustvortrag', 'B.NET_INCOME': 'Jahresüberschuss / Jahresfehlbetrag', 'B.PROVISIONS': 'Rückstellungen', 'B.LIABILITIES': 'Verbindlichkeiten', 'B.DEFERRED': 'Rechnungsabgrenzungsposten', 'B.DEFERRED_TAX': 'Passive latente Steuern',
  REVENUE: 'Umsatzerlöse', INVENTORY_CHANGE: 'Bestandsveränderungen', OWN_WORK: 'Andere aktivierte Eigenleistungen', OTHER_INCOME: 'Sonstige betriebliche Erträge', MATERIAL_RAW: 'Aufwendungen für Roh-, Hilfs- und Betriebsstoffe und bezogene Waren', MATERIAL_SERVICES: 'Aufwendungen für bezogene Leistungen', GROSS_PROFIT: 'Rohergebnis', PERSONNEL_WAGES: 'Löhne und Gehälter', PERSONNEL_SOCIAL: 'Soziale Abgaben und Aufwendungen für Altersversorgung', DEPRECIATION_FIXED: 'Abschreibungen auf Anlagevermögen', DEPRECIATION_CURRENT: 'Abschreibungen auf Umlaufvermögen', OTHER_EXPENSE: 'Sonstige betriebliche Aufwendungen', PARTICIPATION_INCOME: 'Erträge aus Beteiligungen', AFFILIATED_INCOME: 'Erträge aus anderen Wertpapieren und Ausleihungen', INTEREST_INCOME: 'Sonstige Zinsen und ähnliche Erträge', FINANCIAL_DEPRECIATION: 'Abschreibungen auf Finanzanlagen', INTEREST_EXPENSE: 'Zinsen und ähnliche Aufwendungen', INCOME_TAX: 'Steuern vom Einkommen und Ertrag', RESULT_AFTER_TAX: 'Ergebnis nach Steuern', OTHER_TAX: 'Sonstige Steuern', NET_INCOME: 'Jahresüberschuss / Jahresfehlbetrag', COST_OF_SALES: 'Herstellungskosten', GROSS_SALES_PROFIT: 'Bruttoergebnis vom Umsatz', DISTRIBUTION: 'Vertriebskosten', ADMINISTRATION: 'Allgemeine Verwaltungskosten', GROSS_PROFIT_RELIEF: 'Rohergebnis',
}
const date = (value: string) => escapeHtml(value.slice(0, 10).split('-').reverse().join('.'))
const paragraphs = (values: readonly string[]) => values.map(value => `<p>${escapeHtml(value)}</p>`).join('')
const css = `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#eef1f4;color:#17212b;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}.container{max-width:1000px;margin:32px auto;padding:48px;background:white}h1{font-size:30px;line-height:1.2;margin:8px 0 16px}h2{font-size:21px;margin:32px 0 12px;border-bottom:2px solid #334b60;padding-bottom:8px}h3{font-size:17px;margin:22px 0 8px}.text-muted{color:#4b5864}.badge{display:inline-block;padding:4px 8px;border:1px solid #526476;border-radius:4px;font-size:12px}.alert{padding:12px 16px;border:1px solid #b8c7d5;border-radius:6px;background:#f5f8fb}.table{width:100%;border-collapse:collapse;margin:12px 0 24px}.table th,.table td{padding:8px 10px;border-bottom:1px solid #d9e0e6;text-align:left;vertical-align:top}.table th{font-size:13px;background:#f1f4f7}.table .money{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}.total{font-weight:700;border-top:2px solid #334b60}p,td,dd{overflow-wrap:anywhere;white-space:pre-wrap}dl{display:grid;grid-template-columns:180px 1fr;gap:5px 16px}dt{font-weight:600}dd{margin:0}code{overflow-wrap:anywhere;font-size:12px}footer{margin-top:32px;border-top:1px solid #ccc;padding-top:12px;font-size:12px;color:#4b5864}@page{size:A4;margin:16mm}@media print{body{background:white;font-size:10pt}.container{margin:0;padding:0;max-width:none}.screen-only{display:none}h1{font-size:22pt}h2{font-size:15pt;break-after:avoid}h3{break-after:avoid}h2+p{break-after:avoid}.disclosures{break-inside:avoid}.approval{break-inside:avoid;break-after:avoid}footer{break-inside:avoid}thead{display:table-header-group}tr{break-inside:avoid}.table tbody tr:nth-last-child(2),.table tbody tr:nth-last-child(3){break-after:avoid}.table th,.table td{padding:5px 7px}a{color:inherit;text-decoration:none}}@media(max-width:650px){.container{margin:0;padding:20px}h1{font-size:25px}dl{grid-template-columns:1fr;gap:2px}dd{margin-bottom:10px}.table th,.table td{padding:6px 4px;font-size:12px}}`

function statementTable(lines: readonly AnnualAccountLine[], input: AnnualPackageInput, balanceSide?: 'A.' | 'B.') {
  const partialAppropriation = readRecordedAnnualAppropriation(input)
  let rows = balanceSide ? lines.filter(line => line.code.startsWith(balanceSide)) : [...lines]
  if (balanceSide) rows = [...rows.filter(line => !['A.ASSETS', 'B.EQUITY_LIABILITIES'].includes(line.code)), ...rows.filter(line => ['A.ASSETS', 'B.EQUITY_LIABILITIES'].includes(line.code))]
  const label = (line: AnnualAccountLine) => partialAppropriation && ['B.CARRYFORWARD', 'B.NET_INCOME'].includes(line.code) ? line.label : labels[line.code] ?? line.label
  return `<table class="table"><thead><tr><th scope="col">Posten</th><th class="money" scope="col">${date(input.fiscalPeriodEnd)}<br>EUR</th><th class="money" scope="col">${date(input.previousFiscalPeriodEnd)}<br>EUR</th></tr></thead><tbody>${rows.map(line => `<tr${['A.ASSETS', 'B.EQUITY_LIABILITIES', 'NET_INCOME'].includes(line.code) ? ' class="total"' : ''}><td>${escapeHtml(label(line))}</td><td class="money">${euroCents(line.amountCents)}</td><td class="money">${euroCents(line.comparativeCents)}</td></tr>`).join('')}</tbody></table>`
}

function resultAppropriationSection(source: AnnualDocumentSource) {
  const recorded = readRecordedAnnualAppropriation(source.input)
  const heading = '<section><h2>Ergebnisverwendung und UG-Rücklage</h2>'
  if (!recorded) return `${heading}<p>Erfasstes Jahresergebnis: ${euroCents(source.equity.resultCents)} EUR. Gezeichnetes Kapital: ${euroCents(source.equity.shareCapitalCents)} EUR.</p><p>Rücklage nach § 5a Abs. 3 GmbHG: ${source.equity.section5aReserveApplicable ? `anwendbar; Berechnungsnachweis ${escapeHtml(source.equity.reserveCalculationEvidenceId ?? 'nicht erfasst')}. Der Zuführungsbetrag ist in dieser Quellversion nicht strukturiert erfasst.` : 'laut geprüftem Arbeitspapier nicht anwendbar.'}</p><p>Feststellung / Ergebnisverwendung: Beschlussnachweis ${escapeHtml(source.close.resolutionId)}. Aufteilungsbeträge und Beschlussdatum sind in dieser Quellversion nicht strukturiert erfasst.</p></section>`
  const amounts: [string, number][] = [
    ['Gezeichnetes Kapital', recorded.shareCapitalCents],
    ['Jahresüberschuss / Jahresfehlbetrag', recorded.annualResultCents],
    ['Gewinnvortrag aus dem Vorjahr', recorded.priorProfitCarryforwardCents],
    ['Verlustvortrag aus dem Vorjahr (Abzug)', recorded.priorLossCarryforwardCents],
    ['Gesetzliche Rücklage vor Zuführung', recorded.priorStatutoryReserveCents],
    ['Zuführung zur gesetzlichen Rücklage (§ 5a Abs. 3 GmbHG)', recorded.reserveAllocationCents],
    ['Ausschüttung', recorded.distributionCents],
    ['Verbleibender Gewinnvortrag / Verlustvortrag', recorded.carryforwardCents],
  ]
  return `${heading}<p>Erfasste Beträge der teilweisen Ergebnisverwendung aus der freigegebenen Abschlussversion.</p><table class="table"><thead><tr><th scope="col">Posten</th><th class="money" scope="col">EUR</th></tr></thead><tbody>${amounts.map(([label, amount], index) => `<tr${index === amounts.length - 1 ? ' class="total"' : ''}><td>${escapeHtml(label)}</td><td class="money">${euroCents(amount)}</td></tr>`).join('')}</tbody></table><p>Ergebnisverwendung: Beschlussnachweis ${escapeHtml(recorded.resolutionEvidenceId)}.<br>Feststellung: Beschlussnachweis ${escapeHtml(source.close.resolutionId)}. Das Beschlussdatum ist in dieser Quellversion nicht strukturiert erfasst.</p></section>`
}

export function renderAnnualDocument(source: AnnualDocumentSource, mode: AnnualDocumentMode, selection?: DisclosureSelection): string {
  const input = source.input; const manual = mode === 'manual'
  const disclosure = manual ? selectDisclosure(source, selection!) : { notes: input.notes, policies: input.policies }
  const title = manual ? input.profile.size === 'MICRO' ? 'Bilanz zur Hinterlegung' : 'Bilanz und Anhang zur Offenlegung' : 'Jahresabschluss'
  const identity = `<header><span class="badge${manual ? ' screen-only' : ''}">${manual ? 'Zur manuellen Einreichung vorbereitet' : 'Freigegebener Abschluss · Archivfassung'}</span><h1>${title} ${input.fiscalYear}</h1><p><strong>${escapeHtml(input.profile.legalName)}</strong><br>${escapeHtml(input.profile.registeredOffice)} · ${escapeHtml(input.profile.registerCourt)} · ${escapeHtml(input.profile.registerNumber)}</p><p>Geschäftsjahr ${date(input.fiscalPeriodStart)} bis ${date(input.fiscalPeriodEnd)}<br>Vorjahr ${date(input.previousFiscalPeriodStart)} bis ${date(input.previousFiscalPeriodEnd)} · Alle Beträge in EUR</p></header>`
  const publicCodes: readonly string[] = input.profile.size === 'MICRO' ? MICRO_BALANCE_SHEET_ORDER : SMALL_BALANCE_SHEET_ORDER
  const balanceLines = manual ? input.balanceSheet.filter(line => publicCodes.includes(line.code)) : input.balanceSheet
  const balance = `<section><h2>Bilanz</h2><h3>Aktiva</h3>${statementTable(balanceLines, input, 'A.')}<h3>Passiva</h3>${statementTable(balanceLines, input, 'B.')}</section>`
  const notes = `<section class="disclosures"><h2>${source.close.notesRequired ? 'Anhang' : 'Angaben unter der Bilanz'}</h2>${paragraphs(disclosure.policies)}${paragraphs(disclosure.notes)}</section>`
  const internal = manual ? '' : `<section><h2>Gewinn- und Verlustrechnung</h2><p>${input.method === 'GKV' ? 'Gesamtkostenverfahren' : 'Umsatzkostenverfahren'} · Aufwendungen mit negativem Vorzeichen</p>${statementTable(input.incomeStatement, input)}</section>${resultAppropriationSection(source)}<section class="approval"><h2>Erfasste Freigabe und Unterschriften</h2><p>App-Freigabe: ${escapeHtml(source.approvedBy)} · ${date(source.approvedAt)}. Dies ist keine Aussage über eine qualifizierte elektronische Signatur.</p>${source.close.signatures.map(signature => `<p>Gesetzlicher Vertreter: ${escapeHtml(signature.representativeId)} · erfasstes Unterschriftsdatum: ${date(signature.signedAt)} · Nachweis: ${escapeHtml(signature.signatureEvidenceId)}</p>`).join('')}<p>Die Nachweise sind referenziert; Unterschriftsbilder und interne Belege sind nicht beigefügt.</p></section>`
  return `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} ${input.fiscalYear} · ${escapeHtml(input.profile.legalName)}</title><style>${css}</style></head><body><main class="container">${identity}<p class="alert screen-only">Über die Druckfunktion des Browsers drucken / als PDF speichern: A4, Maßstab 100 %, Browser-Kopf- und Fußzeilen ausschalten. ${manual ? 'Nur dieses Dokument einreichen. Die Anleitung separat lesen.' : 'Interne vollständige Fassung. Für das Unternehmensregister das gesonderte minimierte Paket verwenden.'}</p>${balance}${notes}${internal}${manual ? `<p>Der Jahresabschluss wurde am ${date(selection!.establishedOn)} festgestellt.</p>` : ''}<footer${manual ? ' class="screen-only"' : ''}>${manual ? 'Manuelle Einreichungsfassung. Eine Übermittlung ist mit diesem Export nicht erfolgt.' : `Quelle: Paket ${escapeHtml(source.packageId)} · Version ${source.packageVersion}<br>SHA-256: <code>${escapeHtml(source.packageChecksum)}</code><br>Erfasster Stand zum Export. Spätere Änderungen sind nicht enthalten. Keine Bestätigung einer externen Einreichung.`}</footer></main></body></html>`
}

export function annualDocumentFiles(source: AnnualDocumentSource, mode: AnnualDocumentMode, selection?: DisclosureSelection) {
  const fileName = mode === 'annual' ? 'jahresabschluss.html' : 'einreichung.html'
  const files: Record<string, string> = { [fileName]: renderAnnualDocument(source, mode, selection) }
  if (mode === 'annual') files['abschluss.json'] = canonicalJson(source)
  else files['ANLEITUNG.txt'] = manualHandoff(source.input)
  return files
}

export function manualHandoff(input: AnnualPackageInput) {
  return `MANUELLE ${input.profile.size === 'MICRO' ? 'HINTERLEGUNG' : 'OFFENLEGUNG'} — ${input.profile.legalName}, ${input.fiscalYear}
Stand der geprüften Verfahrenshinweise: 13.10.2026. Export ist keine Übermittlung oder Annahmebestätigung.
1. einreichung.html lokal im Browser öffnen. Firma, Sitz, Registerdaten, Geschäftsjahr, Vorjahreswerte und vollständige erforderliche Angaben prüfen. Nur Bilanz ${input.profile.size === 'MICRO' ? 'mit den erforderlichen Angaben unter der Bilanz (§ 264 Abs. 1/2 HGB)' : 'und Anhang ohne ausschließlich GuV-bezogene Angaben (§ 326 Abs. 1 HGB)'} sind vorgesehen. Nicht enthaltene Pflichtangaben im Abschluss berichtigen und eine neue freigegebene Version exportieren.
2. Strg+P: A4, 100 %, Browser-Kopf-/Fußzeilen aus, als durchsuchbare PDF speichern. Jede Seite der PDF auf abgeschnittene Beträge und Vollständigkeit prüfen. HTML, ZIP, manifest.json und abschluss.json sind KEINE Einreichungsformate dieses Exports.
3. https://www.publikations-plattform.de öffnen. Der Übermittler benötigt Registrierung und einmalige Identifizierung. Dies selbst durchführen; die App meldet niemanden an.
4. Auftrag an das Unternehmensregister wählen (Geschäftsjahr beginnt nach 31.12.2021). Firma/Registernummer und Zeitraum ${input.fiscalPeriodStart} bis ${input.fiscalPeriodEnd} eingeben. ${input.profile.size === 'MICRO' ? 'Dauerhafte Hinterlegung wählen; die 2-von-3-Größenmerkmale für die maßgeblichen Abschlussstichtage gegenüber dem Register bestätigen. Sonderausschlüsse mit dem Bilanz-Navigator prüfen.' : 'Veröffentlichung wählen; die Erleichterung für kleine Kapitalgesellschaften anwenden.'}
5. Ausschließlich die PDF aus einreichung.html hochladen. XML ist das maßgebliche Format nach § 11 URV; die Plattform bietet PDF-/Office-Konvertierung an. Alternativ Werte im Webformular erfassen. Aktuelle Gebühren und Konvertierungsbedingungen vor Beauftragung prüfen. Niemals das interne Jahresabschluss-Paket oder Belege hochladen.
6. In der Plattform-Vorschau Identität, Vorjahr, Bilanz und ausgewählte Angaben vollständig abgleichen. Feststellungsdatum und weitere Pflichtfelder aus dem tatsächlichen Beschluss übernehmen, nicht das App-Freigabedatum. Erst anschließend selbst kostenpflichtig beauftragen. Für reguläre Fälle gilt grundsätzlich die Jahresfrist des § 325 Abs. 1a HGB; Sonderfälle separat prüfen.
7. Auftragsbestätigung, übermittelte PDF und späteren Hinterlegungs-/Veröffentlichungsnachweis lokal zusammen mit diesem Manifest archivieren. Eine eigene Bestätigung oder hochgeladene Datei ist kein authentifizierter Gateway-Empfang. Die App setzt durch diesen Export keinen Status „extern eingereicht“.
Quellen:
https://www.gesetze-im-internet.de/hgb/__326.html
https://www.gesetze-im-internet.de/hgb/__264.html
https://www.gesetze-im-internet.de/hgb/__325.html
https://www.gesetze-im-internet.de/urv/__11.html
https://publikations-plattform.de/sp/wexsservlet?page.navid=to_knowledgeable_how-work_annual_publish
https://publikations-plattform.de/sp/wexsservlet?page.navid=to_knowledgeable_how-work_annual_deposit
`
}
