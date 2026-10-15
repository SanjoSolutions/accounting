# Sanjo Buchhaltung

Eine Buchhaltungssoftware für Deutschland. Sie unterstützt die laufende Buchhaltung und den Jahresabschluss kleiner UG (haftungsbeschränkt) und GmbH sowie die Vorbereitung ihrer Steuererklärungen.

Diese initiale Spezifikation beschreibt den aus Anwendung, Tests und Projektdokumentation abgeleiteten Funktionsumfang. Stand: 15.10.2026.

## Anforderungen

| ID | Die Software soll … |
| --- | --- |
| S01 | Unternehmen getrennt verwalten. Im Anmeldemodus erhalten Benutzer zugewiesenen Zugriff als Administrator, Buchhalter oder mit Leserechten. Berechtigungsänderungen und die handelnde Person bleiben nachvollziehbar. Für die lokale Einzelnutzung gibt es einen auf den eigenen Rechner beschränkten Betrieb ohne Anmeldung. |
| S02 | Unternehmensdaten, Geschäftsjahre, Kontenrahmen, Steuerprofile und Rechnungsnummernkreise einrichten. Historische Profile und Kontenzuordnungen werden mit ihrer Gültigkeit und ihren Nachweisen berücksichtigt. |
| S03 | Ausgeglichene doppelte Buchungen mit Buchungsdatum, Belegnummer, Buchungstext, mehreren Kontenzeilen und Belegzuordnung erfassen. Buchungsstapel können vor dem Buchen gespeichert und überarbeitet werden. Gebuchte Einträge bleiben unveränderlich; Korrekturen erfolgen nachvollziehbar über Gegenbuchungen. |
| S04 | Belege hochladen, aufbewahren, anzeigen, herunterladen und Buchungen zuordnen. Rechnungsdaten aus PDF-Text oder strukturierten Rechnungen zur Prüfung bereitstellen und die bestätigten Angaben an den Originalbeleg binden. |
| S05 | Geprüfte Eingangsrechnungen als Lieferantenverbindlichkeit mit offenem Posten, Aufwand, Umsatzsteuerdaten und Belegnachweis buchen. UBL, CII und unterstützte hybride PDF-Rechnungen behalten ihre maßgeblichen strukturierten Angaben. Unterstützte Lieferantengutschriften werden mit nachvollziehbarer Steuerkorrektur verrechnet. |
| S06 | Die ausdrücklich unterstützten Fälle für inländisches Reverse Charge, EU-B2B-Dienstleistungen und innergemeinschaftlichen Warenerwerb nach Prüfung der Nachweise und ausdrücklicher Bestätigung buchen. Die Lieferantenverbindlichkeit bleibt netto; die zugehörigen Umsatzsteuer- und Vorsteuerwerte fließen in den richtigen Meldezeitraum ein. |
| S07 | Ausgangsrechnungen als XRechnung im UBL-Format mit eindeutiger Nummer aus den hinterlegten Ausstellerdaten erstellen, anzeigen und im Original herunterladen. Rechnung, Forderung und Steuerbuchung entstehen zusammen. Unterstützte Teilgutschriften und Vollstornos erhalten die ursprüngliche Rechnung und ihre Korrekturhistorie. |
| S08 | Kunden, Lieferanten, Forderungen und Verbindlichkeiten verwalten. Teilzahlungen, aufgeteilte Zahlungen, Überzahlungen und Gutschriften nachvollziehbar zuordnen und Zuordnungen durch Gegenereignisse rückgängig machen. |
| S09 | Für überfällige Kundenforderungen fortlaufende Mahnungen erstellen, drucken und aufbewahren. E-Mail-Versand benötigt eine ausdrücklich bestätigte Empfängeradresse und Versandfreigabe. Versand und Stornierung bleiben nachvollziehbar und ändern den offenen Rechnungsbetrag nicht. |
| S10 | Bankkonten und CAMT-Kontoauszüge verwalten. Zahlungen nach Prüfung mit offenen Posten abgleichen und gemeinsam mit der Bankbuchung festhalten. Wiederholter Import oder erneute Bestätigung erzeugt keine Doppelbuchung. Ein Abgleich kann nachvollziehbar rückgängig gemacht werden. |
| S11 | Anlagen an nachgewiesene Anschaffungsbuchungen binden, monatliche lineare Abschreibungen berechnen und buchen sowie deren vollständige Gegenbuchung ermöglichen. Nachgewiesene vollständige Abgänge ohne Erlös und unterstützte inländische Vollverkäufe mit 19 % Umsatzsteuer schließen die Anlage ab. |
| S12 | Für das gewählte Geschäftsjahr Journal, Konten, Summen- und Saldenliste, Kontenblätter, Debitoren und Kreditoren, Bilanz und Gewinn- und Verlustrechnung anzeigen. Die Auswertungen lassen sich auf die zugrunde liegenden Buchungen und Belege zurückführen. |
| S13 | DATEV-Buchungsdaten sowie unterstützte Lexware-Betriebsprüfungsordner mit Konten, Stammdaten und Belegen importieren. Wiederholte Importe vermeiden Duplikate. Für Steuerberatung und Betriebsprüfung werden nachvollziehbare DATEV- beziehungsweise GoBD-Exporte bereitgestellt. |
| S14 | Den unterstützten HGB-Jahresabschluss aus gültigen Unternehmensdaten, Kontenzuordnungen und belegten Arbeitspapieren vorbereiten. Vorbereitung und unabhängige Prüfung, Paketfreigabe, Unterschriftsnachweise und Gesellschafterbeschluss bilden die Grundlage der Abschlusssperre. Fehlende oder veraltete Grundlagen blockieren den Abschluss; gesperrte Jahre erlauben keine weiteren Buchungen. |
| S15 | Umsatzsteuer-Voranmeldungen und Umsatzsteuerjahreserklärungen aus abgestimmten Buchungs- und Steuerdaten vorbereiten. Prüfung, Übermittlung, Korrektur, Wiederaufnahme unklarer Übermittlungen und aufbewahrte Empfangsbelege beziehen sich auf den konkreten vorbereiteten Datenstand. |
| S16 | Körperschaftsteuer und Gewerbesteuer für die unterstützten UG/GmbH-Fälle der Kalenderjahre 2025 und 2026 aus abgestimmten Abschlussdaten und belegten steuerlichen Anpassungen vorbereiten. Die unterstützte Gewerbesteuerberechnung ist auf eine Betriebsstätte und eine Gemeinde begrenzt. |
| S17 | Die E-Bilanz mit vollständiger Kontenzuordnung, steuerlicher Überleitung und erforderlichen Zusatzangaben aus dem konkreten Abschlussstand vorbereiten und als versionierte XBRL-Ausgabe aufbewahren. Prüfung, Übermittlung und Empfangsbelege bleiben diesem Stand zugeordnet. Für 2026 mit Taxonomie 6.9 gibt es außerdem ein externes Übergabepaket mit Salden, Zuordnungsvorlage, Datengrundlage und Abstimmung sowie separat zugeordneten Benutzernachweisen. |
| S18 | Freigegebene Jahresabschlüsse in der gewählten Version als druckbare Unterlagen exportieren. Ein gesondertes manuelles Paket für das Unternehmensregister enthält die ausdrücklich ausgewählten Offenlegungsangaben und eine Übergabeanleitung. Historische Exporte bleiben unverändert abrufbar und werden bei überholter Grundlage entsprechend gekennzeichnet. |
| S19 | Im Compliance-Bereich Unternehmens- und Periodengrundlagen, Nachweise, Freigaben, Aufbewahrung und Prüfprotokolle verwalten. Verschlüsselte vollständige Unternehmenssicherungen lassen sich herunterladen und isoliert zur Wiederherstellungsprüfung einspielen; Manipulationen werden erkannt. |
| S20 | Die Bedienung auf Deutsch und Englisch anbieten. Zahlen- und Datumsformat sind unabhängig von der Sprache wählbar. Das gewählte Geschäftsjahr bleibt beim Wechsel zwischen den zugehörigen Arbeitsbereichen erhalten. Beschriftungen und Rückmeldungen sind knapp und verständlich. |

## Produktgrenzen

- Der automatisierte HGB-Abschluss ist auf eigenständige deutsche Kleinst- und kleine UG/GmbH im unterstützten Regelprofil begrenzt. Fehlende Angaben oder nicht unterstützte Sachverhalte blockieren die jeweilige Verarbeitung. Fachliche Bewertungen und verantwortliche Freigaben bleiben erforderlich.
- Lohnabrechnung, vollständige Warenwirtschaft mit Angeboten, Aufträgen und Lieferscheinen, wiederkehrende Abrechnung, Live-Bankzugänge, Konzernabschlüsse und besondere Branchenfälle gehören nicht zum unterstützten Zielumfang. Abweichende Wirtschaftsjahre und komplexe internationale oder steuerliche Sonderfälle sind nicht pauschal abgedeckt.
- Steuerfunktionen gelten nur für installierte und freigegebene Jahres- und Formularversionen. Eine produktive elektronische Abgabe benötigt den qualifizierten Übermittlungsweg und die erforderliche Einrichtung. Lokale Testempfangsbelege belegen den Anwendungsablauf, keine Annahme durch eine Behörde.
- Ein Export oder hochgeladener Benutzerbeleg gilt nicht als bestätigte externe Prüfung, Übermittlung oder Annahme. Die manuelle Registerübergabe und externe E-Bilanz-Bearbeitung bleiben eigenständige Schritte. Ein erfolgreicher Import in fremde Programme oder eine DATEV-Zertifizierung wird nicht zugesichert.

## Übergreifende Anforderungen

- Geldbeträge werden centgenau verarbeitet. Zusammengehörige Buchungen, Steuerdaten, offene Posten und Nachweise entstehen vollständig oder gar nicht.
- Unternehmensdaten und Belege sind gegen unberechtigten Zugriff getrennt. Buchungen, Freigaben, Korrekturen, Exporte und Übermittlungen behalten ihre Herkunft und überprüfbare Historie.
- Freigaben und Übermittlungen gelten für einen bestimmten Datenstand. Änderungen an dessen Grundlagen machen davon abhängige Ergebnisse veraltet und erfordern erneute Vorbereitung oder Prüfung.

Die detaillierten Fallgrenzen stehen in der [UG/GmbH-Abgrenzung](documentation/ug-supported-scope-and-e2e-proof.md), dem [HGB-Regelprofil](documentation/hgb-close-supported-scope.md) und der jeweiligen [Fachdokumentation](documentation/). Konkrete Datenformate und technische Verträge werden durch die automatisierten Tests beschrieben.
