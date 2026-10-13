# Externe E-Bilanz 2026

Der Export für myebilanz BASIS enthält unveränderlich gespeicherte Kontensalden,
eine **Zuordnungsvorlage**, die vollständige autoritative Datengrundlage, XBRL,
Abstimmung und Prüfsummen. Er ist zur externen Bearbeitung und Prüfung bestimmt.
Ein vollständiger Import oder eine erfolgreiche ERiC-Validierung in myebilanz
wurde nicht ausgeführt. Das ZIP ist kein zugesichertes Importformat einer
Empfängeranwendung.

## Empfängervertrag

Geprüft am 13.10.2026: myebilanz-Handbuch Version 2.3.1.x, Abschnitte 3.2.2,
15.5 und 15.6. [Funktionen](https://www.myebilanz.de/050-funktionen.php) und
[PLUS-Abgrenzung](https://www.myebilanz.de/075-plus-funktionen.php) bestätigen
CSV/Textkonfiguration in BASIS. Automatischer Import von Kontenzuordnungen und
XBRL-Import erfordern PLUS; letzterer umfasst nur Bilanz/GuV. Die
[Versionsmeldung 2.3.0.0](https://www.myebilanz.de/forum/viewtopic.php?p=2425)
ist kein Nachweis für die Validierung unserer Bytes. Maßgeblich sind die
lokale Darstellung und Prüfung im aktuell installierten Zielprogramm.

Der Adapter ist bewusst auf Geschäftsjahr 2026 und Taxonomie 6.9 begrenzt.
Die Freigabe anderer Taxonomien benötigt einen neuen dokumentierten Adapter.

| Datei | Vertrag |
| --- | --- |
| `myebilanz-salden.csv` | Kein Kopf; Konto, Saldo Soll minus Haben, unveränderte Bezeichnung |
| `susa.csv` | Kopf; Konto, Bezeichnung, Soll, Haben, Saldo, Taxonomieposition |
| `myebilanz-mapping.ini.template` | ASCII, dadurch Windows-1252-kompatibel; `[csv]`, `[period]`, `[xbrl]` zum geprüften Übernehmen in die eigene INI |
| `datengrundlage.json` | Vollständiger gemeinsamer Exportdatensatz aus #36, einschließlich Überleitung und Anlagen |
| `e-bilanz.xbrl`, `xbrl-mit-taxonomie.zip` | Exakte Ausgabe des gemeinsamen XBRL-Serialisierers; kein BASIS-Importversprechen |
| `abstimmung.json` | Kontenzahl, Soll/Haben-Centsummen, Differenz, Anzahl Nullsalden |
| `manifest.json`, `SHA256SUMS.txt` | Version, Abschlussgeneration, Quellfingerprint und Hash jedes enthaltenen Datenartefakts |

CSV-Regeln: UTF-8 ohne BOM; Semikolon; CRLF; Dezimalpunkt; zwei Nachkommastellen;
keine Tausendertrenner. Alle Zellen sind in doppelten Anführungszeichen,
innere Anführungszeichen in der portablen SuSa verdoppelt. **myebilanz unterstützt
dieses Escaping nicht**. Bei betroffenen Konten werden seine CSV und INI-Vorlage
nicht erzeugt; das Manifest nennt die Einschränkung und den portablen manuellen
Alternativweg. Originalbezeichnungen werden niemals stillschweigend geändert.
Sollsaldo positiv, Habensaldo negativ,
Nullsaldo `0.00`. Der Adapter entfernt keine übergebenen Nullsalden; die gemeinsame
Datengrundlage enthält die verwendeten Konten, einschließlich inzwischen inaktiver
Konten und Konten mit Bewegungen, deren Saldo null ist. Konto 0,
doppelte Nummern, Steuerzeichen, ungültige Centwerte, unausgeglichene Summen
und unzugeordnete Nichtnullsalden blockieren den Adapter. Bezeichnungen bleiben
unverändert; bei Tabellenprogrammen Textimport verwenden, um Formelauswertung
zu vermeiden. Die INI-Vorlage enthält keine Benutzerdaten oder Zugangsdaten.

## Übergabe

1. Gespeicherte Version wählen, Abstimmung und Datengrundlage prüfen, ZIP und
   dessen angezeigten SHA-256 aufbewahren. Nur Kopien im Zielprogramm bearbeiten.
2. Neue BASIS-Datei erstellen, CSV-Pfad absolut setzen und die bereitgestellten
   INI-Abschnitte übernehmen. Die eigene INI als ANSI/Windows-1252 speichern;
   CSV bleibt UTF-8. Firmen- und Lieferantendaten im Zielprogramm ergänzen.
3. Jahresergebnis/Pseudokonto 0, Eigenkapital und UG-Rücklage, Vorjahr, BVV,
   steuerliche Überleitung und Anlagen anhand der vollständigen Datengrundlage
   abgleichen. Die CSV enthält Buchsalden, nicht unbemerkt veränderte Steuersalden.
4. Darstellung und lokale Validierung im Zielprogramm prüfen. Eine dortige
   Abgabe ist eine gesonderte Benutzerentscheidung. Diese Anwendung übermittelt
   weder einen Testfall noch einen Echtfall.
5. Validierungsbericht, tatsächliche Sendebytes und Protokoll aufbewahren.
   Hier den Beleg ausdrücklich an die konkrete Exportversion hängen und Änderungen
   im Zielprogramm erläutern. Die Quellenbindung sagt nicht, dass die späteren
   Sendebytes mit unserem ZIP identisch sind.

Die Zuordnungsvorlage automatisiert nicht alle Pflichtfelder. Insbesondere die
vollständigen Überleitungs-, GCD-, BVV- und Anlagenangaben müssen im Zielprogramm
geprüft werden. Kann dieses einen erforderlichen Sachverhalt nicht erfassen,
keine Angabe weglassen: Als konkrete manuelle Alternative in
[eBilanz-Online](https://www.ebilanzonline.de/wissen/faq/registrierung-und-anmeldung/)
eine Periode anlegen und die vollständigen Daten dort erfassen und validieren.
Auch dafür wird kein automatischer ZIP-Import behauptet. Der Anbieter nennt
[39 EUR netto je Übertragung ohne Abo](https://www.ebilanzonline.de/preismodell/).
[eBilanz+](https://ebilanzplus.de/kosten) nennt 35 EUR netto je Abgabe. Preise sind
keine Kaufempfehlung oder Bestellfreigabe; Registrierung/Kauf verbleiben beim Benutzer.

## Technische und Vertrauensgrenzen

Der gemeinsame Anbieter aus #36 prüft Abschlussgeneration, vollständige
Datengrundlage und Quellfingerprint. Vor der Registrierung werden diese
innerhalb derselben Datenbanktransaktion erneut gelesen. Exporte benötigen keine
ELSTER-Entwicklerkennung, Hersteller-ID, ERiC-Laufzeit oder Gateway-Zugangsdaten
und nutzen keinen globalen Entwurfs-Bypass.

Downloads lesen ausschließlich die gewählte gespeicherte Version, prüfen
Paket- und Dateihashes und protokollieren den tatsächlichen Actor. Historische
Versionen bleiben mit veraltetem Status abrufbar. READ_ONLY darf lesen;
Erstellen und Nachweise erfassen erfordern ADMIN/ACCOUNTANT. Mandant und Actor
stammen aus der authentifizierten Sitzung, nie aus Uploadfeldern.

Nachweise sind separate append-only Aufbewahrungsartefakte mit Paket-ID,
Paketversion, Pakethash und unveränderten Belegbytes. Auch ein als Annahme
bezeichneter Upload hat stets `USER_SUPPLIED_UNAUTHENTICATED`. Er aktualisiert
keine offiziellen Submission-/Gateway-Tabellen und erteilt keine vertrauenswürdige
Annahme. Externe Validierung, Übermittlung und Annahme werden separat angezeigt.

## Integration und Prüfung

`prepareAuthoritativeEBalanceExport` liefert Datensatz, XML und lokale
Strukturdiagnostik. Der Adapter speichert dessen Datensatzchecksum als
Quellfingerprint und übernimmt das XML unverändert. `assertCurrentEBalanceExport`
prüft in der Veröffentlichungstransaktion Abschluss, aktuelle Überleitung und
Belegchecksummen erneut. Ein Export benötigt eine bereits vorhandene
Abschlussgeneration; reine Lesezugriffe lösen keine Legacy-Nachanlage aus.

Vitest deckt CSV-Vertrag, exakte XBRL-Übernahme, abweichendes Geschäftsjahr,
Steuerkorrekturen und Anlagen, Aufbewahrung, Manipulationserkennung, Rollen,
Mandantentrennung und Änderungen vor Veröffentlichung ab. Der isolierte
Playwright-Test (`playwright.external-ebilanz.config.ts`, Port 3112) verwendet
synthetische historische Versionen, echten Speicher und echte HTTP-Endpunkte:
Version wählen, Anleitung ansehen, Originalbytes herunterladen und einen
Benutzerbeleg an genau diesen Pakethash hängen. Er behauptet weder eine aktuelle
Abschlussfreigabe dieser historischen Testdaten noch einen Empfängerimport.
