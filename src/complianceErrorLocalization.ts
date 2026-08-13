const germanComplianceErrors: Readonly<Record<string, string>> = {
  'JSON object required': 'Ein JSON-Objekt ist erforderlich.',
  'Valid effective date required': 'Ein gültiges Wirksamkeitsdatum ist erforderlich.',
  'Compliance action failed': 'Die Compliance-Aktion ist fehlgeschlagen.',
  'Compliance request body must be an object': 'Die Compliance-Anfrage muss ein Objekt sein.',
  'Unsupported compliance action': 'Diese Compliance-Aktion wird nicht unterstützt.',
  'One or more unique historical fiscal years are required': 'Mindestens ein eindeutiges historisches Geschäftsjahr ist erforderlich.',
  'Historical HGB fiscal year must be a four-digit integer': 'Das historische HGB-Geschäftsjahr muss vierstellig sein.',
  'Retained evidence document ID is required': 'Die Dokument-ID des aufbewahrten Nachweises ist erforderlich.',
  'A documented reason is required': 'Ein dokumentierter Grund ist erforderlich.',
  'A custom HGB chart ID is required': 'Eine ID für den individuellen HGB-Kontenrahmen ist erforderlich.',
  'At least one HGB mapping is required': 'Mindestens eine HGB-Zuordnung ist erforderlich.',
  'Complete operator, jurisdiction, recovery, key and reason facts are required': 'Angaben zu Bedienern, Rechtsraum, Wiederherstellung, Schlüssel und Begründung müssen vollständig sein.',
  'Company profile contains a non-JSON value': 'Das Unternehmensprofil enthält einen Wert, der nicht als JSON gespeichert werden kann.',
  'Settings section must be an object': 'Der Einstellungsbereich muss ein Objekt sein.',
  'Settings changed concurrently; reload before saving': 'Die Einstellungen wurden gleichzeitig geändert. Bitte laden Sie die Seite vor dem Speichern neu.',
  'registerCourt and registerNumber must be supplied together': 'Registergericht und Registernummer müssen gemeinsam angegeben werden.',
  'taxNumber has an invalid format': 'Die Steuernummer hat ein ungültiges Format.',
  'vatId must be a German VAT ID': 'Die USt-IdNr. muss eine gültige deutsche USt-IdNr. sein.',
  'legalForm is invalid': 'Die Rechtsform ist ungültig.',
  'vatRegime is invalid': 'Die Umsatzsteuerregelung ist ungültig.',
  'vatFilingFrequency is invalid': 'Der USt-Voranmeldungszeitraum ist ungültig.',
  'sizeClass is invalid': 'Die Größenklasse ist ungültig.',
  'registeredAddress is invalid': 'Die Geschäftsanschrift ist ungültig.',
  'chart is invalid': 'Der Kontenrahmen ist ungültig.',
  'elections must be a string array': 'Die steuerlichen Wahlrechte müssen als Liste von Textwerten angegeben werden.',
  'annualTaxProfile requires canonical trade, establishment and adviser facts': 'Das Jahressteuerprofil benötigt vollständige Angaben zu Gewerbebetrieb, Betriebsstätten und steuerlicher Beratung.',
  'annualTaxProfile municipalityCode is invalid': 'Der Gemeindeschlüssel im Jahressteuerprofil ist ungültig.',
  'annualTaxProfile tradeTaxMultiplierBasisPoints is invalid': 'Der Gewerbesteuer-Hebesatz im Jahressteuerprofil ist ungültig.',
  'annualTaxProfile establishmentAllocations is invalid': 'Die Betriebsstättenzerlegung im Jahressteuerprofil ist ungültig.',
  'eBilanz requires canonical reporting profile facts': 'Für die E-Bilanz sind vollständige Berichtsprofildaten erforderlich.',
  'applicabilityOverrides is invalid': 'Die Abweichungen zur Berichtspflicht sind ungültig.',
  'registeredAddress is required for an authoritative profile version': 'Für eine maßgebliche Profilversion ist die Geschäftsanschrift erforderlich.',
  'profile dates must be real YYYY-MM-DD dates': 'Profildaten müssen gültige Datumswerte im Format JJJJ-MM-TT sein.',
  'profile effective range is invalid': 'Der Gültigkeitszeitraum des Profils ist ungültig.',
  'profile versions overlap': 'Die Gültigkeitszeiträume der Profilversionen überschneiden sich.',
  'Earlier company profile validity requires explicit onboarding confirmation': 'Für einen früheren Gültigkeitsbeginn ist eine ausdrückliche Bestätigung zur Ersteinrichtung erforderlich.',
  'Earlier company profile validity can only be confirmed for initial or unchanged profile facts': 'Ein früherer Gültigkeitsbeginn kann nur für erstmalig erfasste oder unveränderte Unternehmensdaten bestätigt werden.',
  'Earlier company profile validity conflicts with an existing different profile version': 'Der frühere Gültigkeitsbeginn widerspricht einer bereits vorhandenen abweichenden Profilversion.',
  'Earlier company profile validity requires an existing account-mapping cohort for the selected chart': 'Für den früheren Gültigkeitsbeginn ist eine vorhandene Kontenzuordnung für den ausgewählten Kontenrahmen erforderlich.',
  'Earlier company profile validity conflicts with an existing different account-mapping cohort': 'Der frühere Gültigkeitsbeginn widerspricht einer bereits vorhandenen abweichenden Kontenzuordnung.',
  'The authenticated user is not an operator for this tenant': 'Der angemeldete Benutzer ist für dieses Unternehmen nicht als Bediener berechtigt.',
  'A nonblank reason is required': 'Eine Begründung ist erforderlich.',
  'No authoritative company profile covers the requested mapping date': 'Für das angeforderte Zuordnungsdatum ist kein maßgebliches Unternehmensprofil vorhanden.',
  'The authoritative company profile is invalid': 'Das maßgebliche Unternehmensprofil ist ungültig.',
  'The authoritative company profile has no valid chart': 'Im maßgeblichen Unternehmensprofil ist kein gültiger Kontenrahmen hinterlegt.',
  'At least one storage region is required': 'Mindestens eine Speicherregion ist erforderlich.',
  'Drafts can only be created or revised in an open fiscal period': 'Entwürfe können nur in einem offenen Geschäftsjahr erstellt oder geändert werden.',
  'Compliance policy is no longer available': 'Die Compliance-Richtlinie ist nicht mehr verfügbar.',
  'Compliance policy operator authorization is invalid': 'Die Bedienerberechtigung der Compliance-Richtlinie ist ungültig.',
  'The authenticated user is no longer an operator for this tenant': 'Der angemeldete Benutzer ist für dieses Unternehmen nicht mehr als Bediener berechtigt.',
  'Invalid overview date': 'Das Stichtagsdatum der Übersicht ist ungültig.',
  'Fiscal period payload must be an object': 'Die Angaben zum Geschäftsjahr müssen ein Objekt sein.',
  'referenceYear must be an integer from 1900 to 2200': 'Das Bezugsjahr muss eine ganze Zahl zwischen 1900 und 2200 sein.',
  'startsAt and endsAt are required': 'Beginn und Ende sind erforderlich.',
  'Fiscal period not found': 'Das Geschäftsjahr wurde nicht gefunden.',
  'Four-eyes approval is required': 'Eine Freigabe nach dem Vier-Augen-Prinzip ist erforderlich.',
  'Policy payload must be an object': 'Die Richtlinienangaben müssen ein Objekt sein.',
  'Storage region is unavailable': 'Die Speicherregion ist nicht verfügbar.',
  'operatorIds must include the configuring actor': 'Die Bedienerliste muss den aktuell konfigurierenden Benutzer enthalten.',
  'backupKeyId is required': 'Die ID des Sicherungsschlüssels ist erforderlich.',
  'Compliance operator authorization is required': 'Eine Bedienerberechtigung für Compliance ist erforderlich.',
  'Retained artifact not found': 'Das aufbewahrte Objekt wurde nicht gefunden.',
  'Audit chain verification failed; backup aborted': 'Die Prüfung der Audit-Kette ist fehlgeschlagen. Die Sicherung wurde abgebrochen.',
  'Backup manifest not found': 'Das Sicherungsmanifest wurde nicht gefunden.',
  'Invalid JSON payload': 'Die JSON-Daten sind ungültig.',
}

const germanFieldLabels: Readonly<Record<string, string>> = {
  companyName: 'Unternehmensname', taxNumber: 'Steuernummer', taxOffice: 'Finanzamt', activity: 'Geschäftstätigkeit',
  registerCourt: 'Registergericht', registerNumber: 'Registernummer', registeredAddress: 'Geschäftsanschrift',
  streetAndHouseNumber: 'Straße und Hausnummer', zipCode: 'Postleitzahl', city: 'Ort', country: 'Land',
  fiscalPeriodId: 'Geschäftsjahr-ID', expectedVersion: 'Erwartete Version', expectedChecksum: 'Erwartete Prüfsumme',
  backupKeyId: 'Sicherungsschlüssel-ID', effectiveFrom: 'Gültig ab', startsAt: 'Beginn', endsAt: 'Ende',
}

function fieldLabel(value: string) {
  const lastSegment = value.split('.').at(-1) ?? value
  return germanFieldLabels[lastSegment] ?? value
}

function translateGermanComplianceErrorPart(message: string): string {
  const exact = germanComplianceErrors[message]
  if (exact) return exact
  let match = message.match(/^(.+) is required$/)
  if (match) return `${fieldLabel(match[1])} ist erforderlich.`
  match = message.match(/^(.+) must be a real YYYY-MM-DD date$/)
  if (match) return `${fieldLabel(match[1])} muss ein gültiges Datum im Format JJJJ-MM-TT sein.`
  match = message.match(/^invoiceIssuer\.(.+) must be a string$/)
  if (match) return `${fieldLabel(match[1])} der Rechnungsausstellerdaten muss als Text angegeben werden.`
  match = message.match(/^annualTaxProfile (.+) must be boolean$/)
  if (match) return `${fieldLabel(match[1])} im Jahressteuerprofil muss mit Ja oder Nein angegeben werden.`
  match = message.match(/^(.+) must be a nonnegative integer$/)
  if (match) return `${fieldLabel(match[1])} muss eine nicht negative ganze Zahl sein.`
  return message
}

/** Localizes known client and API errors shown by the compliance workspace. */
export function localizeComplianceError(message: string, locale: string): string {
  if (!locale.toLowerCase().startsWith('de')) return message
  return message.split(';').map(part => translateGermanComplianceErrorPart(part.trim())).join(' ')
}
