# VibeLetter CLI

Diese Datei und die beiden llms-Dateien entstehen aus dem echten Commander-Befehlsbaum und ausgeführtem --help. Ändere den Befehlsbaum oder diesen Generator, nicht die generierten Hilfeblöcke.

## Starten

Node.js 24 oder neuer. Im Quellrepository:

```sh
npm run build --workspace @vibelabsdotto/vibeletter-cli
node apps/cli/dist/index.js --help
npm run cli -- --help
node apps/cli/dist/index.js catalog --json
```

Das npm-Paket heißt @vibelabsdotto/vibeletter-cli, das ausführbare Programm vibeletter. npm link --workspace @vibelabsdotto/vibeletter-cli kann den bereits gebauten Workspace lokal verlinken. Eine globale Veröffentlichung ist dafür nicht nötig.

Der Root-Wrapper verwendet den gebauten Bin direkt und behält das Repository als Arbeitsverzeichnis. Damit bleibt .vibeletter/config.json im Repository der lokale Kontext. Baue die CLI vor dem ersten Aufruf. Für reine JSON-Ausgabe über npm: npm run --silent cli -- --json readiness.

## Kontexte und Tokens

Globale Datei: ~/.config/vibeletter/config.json. Lokale Datei: .vibeletter/config.json im aktuellen Arbeitsverzeichnis. Schreiboperationen verwenden standardmäßig --scope global. Ein ausdrückliches --scope local oder --scope global liest nur diese Datei, ohne Kontext- oder Credential-Fallback auf die andere Datei. Verzeichnisse haben Modus 0700, Dateien Modus 0600. Der CLI ersetzt Dateien per atomarem Rename nach fsync. Symlinks und unsichere Token-Dateien werden abgewiesen. Ungültige Konfiguration wird nicht stillschweigend überschrieben.

```sh
vibeletter context set development --instance http://localhost:3035 --scope local --token-file /private/path/operator.token
vibeletter context use development --scope local
vibeletter context list --json
vibeletter context show --json
vibeletter context verify development --scope local --json
vibeletter context set production --instance https://letters.example.com --token-stdin < /private/path/operator.token
vibeletter context use production
vibeletter readiness --instance http://localhost:3035 --json
```

Kein Token steht im Argumentvektor. --token-env nennt eine Umgebungsvariable, nicht deren Wert. Ohne ausdrückliche Token-Quelle verwendet context set VIBELETTER_TOKEN, sofern gesetzt. Ansonsten bleibt ein vorhandenes Token nur bei unveränderter Instanz erhalten. --clear-token entfernt es. Token-Dateien müssen dem aktuellen Nutzer gehören und dürfen keine Gruppen- oder Fremdrechte haben. Datei/stdin dürfen genau ein abschließendes LF oder CRLF enthalten; andere Leerzeichen werden nicht entfernt.

Instanz-Priorität: --instance oder --context, danach VIBELETTER_INSTANCE, danach ausgewählter Kontext, danach lokale/globale Defaults, schließlich http://localhost:3035. --instance und --context zusammen sind ein Fehler. Token-Priorität: VIBELETTER_TOKEN, danach Token des ausgewählten Kontextes, danach passender Konfigurations-Default. Ein gespeichertes Token wird niemals auf eine andere Instanz übertragen. URLs enthalten keine Zugangsdaten, Query oder Fragmente. HTTPS ist Pflicht außerhalb von Loopback. Der HTTP-Client folgt keinen Redirects. Kontextnamen sind 1 bis 64 Buchstaben, Ziffern, Unterstriche oder Bindestriche. Lokale Kontexte gleichen Namens haben Vorrang; --scope bei Kontext-Leseoperationen und verify wählt eine konkrete Datei. health erfordert ein gültiges Token mit health:read, context verify zusätzlich overview:read.

JSON-Format der Konfiguration:

```json
{
  "version": 1,
  "currentContext": "production",
  "contexts": {
    "production": { "instance": "https://letters.example.com" }
  }
}
```

readiness liest die öffentliche /api/v1/health ohne Token und sendet keinen Authorization-Header, auch wenn ein Token konfiguriert ist. health und context verify bleiben authentifiziert und verwenden /api/v1/health/details. Öffentliche Readiness prüft keine Berechtigungen und ersetzt keine Kontext-Verifikation.

Gespeicherte Zugangsdaten stehen optional als token im jeweiligen Kontext. Leseoperationen zeigen nur [REDACTED], niemals Teile des Tokens. instance und token auf oberster Ebene sind optionale Konfigurations-Defaults. Schlüssel-Erstellung ist die einzige API-Operation, deren Antwort ein neues Klartext-Token enthalten darf. keys create --out prüft Zieltyp, Symlinks und die Schreibbarkeit des Verzeichnisses vor dem POST. Die Antwort wird mit Modus 0600 gespeichert, stdout enthält nur Pfad und Byteanzahl. Scheitert das Speichern trotzdem, versucht die CLI genau einmal, ausschließlich die ID aus dieser erfolgreichen Erstellungsantwort zu widerrufen, und prüft sie per GET nach. key_output_failed nennt keyId und revoked, nie das Klartext-Token. Bei revoked:false ist der Widerruf nicht bestätigt. Prüfe keys get <keyId> auf derselben Instanz und widerrufe den Schlüssel manuell. Fehlt eine eindeutig gültige neue ID, erfolgt kein automatischer Widerruf. Die Erstellung wird nie automatisch wiederholt. Die CLI erweitert keine Scopes eines vorhandenen Schlüssels. Der Server prüft angeforderte Scopes gegen den authentifizierten Actor.

## JSON, HTML und Markdown

Schreibbefehle akzeptieren --file für ein JSON-Objekt. - liest stdin. Benannte Feldoptionen überschreiben gleichnamige Dateifelder. Nicht gelistete originale und verschachtelte Einstellungen bleiben über JSON möglich. Dateigröße/stdin sind begrenzt. Jeder Aufruf kann stdin nur einmal lesen.

Newsletter-Felder heißen name, slug, fromName, fromEmail, replyTo und postalAddress. Kontakt- und Kampagnenerstellung verwenden newsletter als Slug, nicht newsletterId. IDs für Newsletter, Kontakte, Kampagnen, Schlüssel und Sperren bestehen aus genau 24 Hex-Zeichen; ihre Schreibweise bleibt erhalten. Queue-IDs sind positive Dezimalzahlen ohne führende Nullen. Domain-Kennungen sind Domainnamen.

```sh
vibeletter newsletters create --name Updates --slug updates --from-name Team --from-email updates@example.com --postal-address "Example Street 1"
vibeletter newsletters update <id> --file newsletter-settings.json
vibeletter contacts create --newsletter updates --email reader@example.com --source website
vibeletter campaigns create --newsletter updates --subject "October update" --preview-text "The latest changes" --markdown-file issue.md
vibeletter campaigns update <id> --html-file issue.html
vibeletter campaigns create --file - < campaign.json
vibeletter campaigns preview <id> --out preview.html
vibeletter campaigns report <id> --out report.json
```

Nicht leere html- und markdown-Inhalte schließen einander aus. campaigns create braucht nur den Newsletter-Slug und kann einen leeren Entwurf anlegen. Inhalte kommen aus JSON oder --html-file/--markdown-file. Originale Feldnamen werden weder in einen anderen Newsletter-Namen noch in neue Kampagnenfelder umbenannt.

campaigns list erhält neben items, total, limit und offset auch issues, issuesTotal, issuesLimit und issuesOffset samt öffentlichen URLs. Veröffentlichte issues bilden eine eigene Sammlung und folgen nicht dem Statusfilter der Operator-Liste. Ohne --all bleiben beide Sammlungen paginiert. --all liest beide vollständig ab Offset 0, auch wenn eine Sammlung mehr Seiten hat oder items leer ist. Jede Sammlung wird auf stabile Gesamtzahl, erwartete Offsets und eindeutige IDs geprüft. Bei Änderungen oder fehlenden Seiten bricht die CLI ab, statt eine erste Issue-Seite als vollständig auszugeben. limit und issuesLimit nennen weiterhin die verwendete Seitengröße.

campaigns report erhält alle vom Server gelieferten JSON-Felder unverändert, einschließlich providers und events. providers zählt tatsächlich versandte Kampagnennachrichten je Provider, keine Willkommens-, Bestätigungs- oder Testnachrichten. messages und events sind eigenständige paginierte Sammlungen mit items, total, limit und offset. --limit und --offset gelten für beide Sammlungen, nicht für eine kombinierte Gesamtzahl. Der Bericht besitzt kein --all; die angezeigte Nachrichten- oder Ereignisseite behauptet keine vollständige Sammlung.

## Kontakte importieren und exportieren

```sh
vibeletter contacts import --newsletter updates --file contacts.csv --batch-size 1000 --json
vibeletter contacts import --format json --file import.json --json
vibeletter contacts import --newsletter updates --file - < contacts.csv
vibeletter contacts export --newsletter updates --out contacts.csv --json
vibeletter contacts export --newsletter updates --format json --out contacts.json
vibeletter contacts export --newsletter updates --raw-csv --out reimport.csv
vibeletter contacts status <id> unsubscribed
```

CSV unterstützt Kommas, CRLF/LF, UTF-8-BOM, Anführungszeichen und eingebettete Zeilenumbrüche. email ist erforderlich. status fehlt bedeutet active; zulässig sind active, dormant, unsubscribed, bounced, complained. Optionale Importfelder: subscribedAt, emailsReceived, openRate, clickRate. Raten sind 0 bis 1 oder Prozentwerte wie 25%. Mehrere verbreitete email/status-Spaltennamen werden erkannt. Ungültiges CSV wird vor der ersten HTTP-Anfrage abgewiesen. JSON-Import erwartet {"newsletter":"updates","rows":[{"email":"reader@example.com","status":"active"}]}; source ist optional.

Importe laufen sequentiell in Batches mit maximal 1000 Zeilen. Die Serverregeln verhindern das Reaktivieren durch Import. Ein fehlgeschlagener Batch beendet den Aufruf mit Fehler, completedBatches, rowsSubmitted und den tatsächlichen Antworten bisheriger Batches. Es gibt keine automatische Wiederholung und keine Rücknahme bereits erfolgreicher Batches.

Export liest alle REST-Listenseiten, prüft total, offset und eindeutige IDs, bevor eine Datei ersetzt wird. Verändert sich total, bricht der Export ab. CSV enthält _id, newsletterId, email, status, source, subscribedAt, unsubscribedAt, emailsReceived, openRate und clickRate. Importierte Kennzahlen werden aus imported gelesen. subscribedAt muss einen ISO-8601-Zeitpunkt mit Sekunden und Zeitzone enthalten. JSON exportiert die vollständigen API-Datensätze samt Listen-Metadaten. CSV-Import ignoriert System- und Metadatenspalten wie _id, newsletterId, source und unsubscribedAt. Die Import-Herkunft wird für alle Zeilen über --source gesetzt. JSON-Import erlaubt nur die genannten Importfelder und prüft alle Zeilen vor dem ersten Request. CSV schützt standardmäßig vor Tabellenkalkulationsformeln. --raw-csv erhält Werte für maschinellen Reimport, gehört aber nicht in eine ungeschützte Tabellenkalkulation. Neue Datenbank-IDs werden beim Import serverseitig bestimmt. pending ist kein CSV-Importstatus. Import ist keine Wiederherstellung von Systemfeldern und löst keine Willkommensmail aus.

Ohne --out schreibt Export stdout. --out - wählt stdout ausdrücklich. --json und CSV auf stdout sind inkompatibel. Mit --out enthält JSON nur Pfad, total und Byteanzahl; die CSV liegt in der privaten Datei.

## Versand und globale Sperren

send, test, schedule, resume, send-more und newsletters welcome-test können Mail auslösen, wenn der Server Versand aktiviert hat. Ohne SENDING_ENABLED meldet der echte Server einen Fehler, keine simulierte erfolgreiche Zustellung. Prüfe Instanz, Newsletter und Zielgruppe vor dem Aufruf. cleanup-preview und preview senden nicht. schedule --at verlangt Sekunden und eine explizite Zeitzone. pin --value setzt einen booleschen Wert statt eines unbemerkten Umschaltens. newsletters delete, contacts delete und campaigns delete benötigen --confirm; campaigns delete verwirft den Entwurf statt ihn physisch zu löschen. Entfernen einer globalen Sperre benötigt suppressions remove <id> --confirm und ändert nicht selbst den geschützten Kontaktstatus.

```sh
vibeletter campaigns cleanup-preview <id> --json
vibeletter campaigns schedule <id> --at 2027-01-15T10:00:00+01:00 --audience-limit 50
vibeletter campaigns pin <id> --value true
vibeletter keys create --name contacts-reader --scopes contacts:read --out created-key.json
vibeletter suppressions add --email blocked@example.com --reason manual
vibeletter suppressions remove <id> --confirm
vibeletter domains account --json
vibeletter uploads create image.png
```

Uploads senden unveränderte Bildbytes mit passendem Content-Type und X-File-Name, kein multipart/form-data. Dateinamen im Header werden URI-kodiert. PNG, JPEG, GIF und WebP sind zulässig, bis 4 MiB. Der Server prüft tatsächliche Bildbytes und seine Storage-Konfiguration; ein MIME-Label allein macht keine Datei gültig. stdin braucht --name und gegebenenfalls --mime.

## Fehler und Ausgaben

Normale Antworten sind eingerücktes JSON, --json macht sie kompakt. JSON-Fehler stehen auf stderr als {"error":{"code":"…","message":"…","status":400,"details":{}}}; status und details fehlen, wenn nicht vorhanden. Fehler haben einen Exitcode ungleich 0, Hilfe und Version Exitcode 0. Tokens werden auch aus Fehlermeldungen entfernt. --timeout begrenzt Verbindung und Antwortkörper. Nicht-JSON, unvollständige Listen und {error:…}/{ok:false} in einer 2xx-Antwort gelten nicht als Erfolg. Leere 204-Antworten werden als null ausgegeben.

Schreiboperationen werden nie automatisch wiederholt. Bei Verbindungs-/Timeoutfehler nach einem Schreibaufruf lautet der Code outcome_unknown. Lies den Ziel-Datensatz oder die Queue, bevor du selbst erneut sendest. Ein HTTP-Erfolg allein bedeutet nicht, dass eine Mail beim Empfänger angekommen ist.

queue retry wird mit HTTP 409 verweigert, wenn die Zustellung unklar ist oder der Provider die Nachricht bereits akzeptiert hatte. Auch ein späterer Providerfehler erlaubt keinen blinden Neuversand. Prüfe Auftrag, Providerstatus und Ereignisse, statt dieselbe Anfrage zu wiederholen. Die CLI übernimmt den Serverfehler und wiederholt den Schreibaufruf nicht.

catalog --json enthält den lokalen Befehlsvertrag mit Argumenten, Optionen und HTTP-Zuordnung, keine Behauptung über die aktuelle Provider-Verfügbarkeit. Authentifizierung, Scopes und Versandregeln bleiben beim Server. DB-Migration und Operator-Provisionierung sind lokale Web-Workspace-Kommandos, kein versteckter Remote-CLI-Pfad.

## Dokumentation aktualisieren

```sh
npm run build --workspace @vibelabsdotto/vibeletter-cli
npm run docs --workspace @vibelabsdotto/vibeletter-cli
npm run docs:check --workspace @vibelabsdotto/vibeletter-cli
```

## HTTP-Zuordnung

| Befehl | Methode | Pfad | Body/Verhalten |
| --- | --- | --- | --- |
| `vibeletter health` | GET | `/api/v1/health/details` |  |
| `vibeletter readiness` | GET | `/api/v1/health` | public readiness, no Authorization header |
| `vibeletter overview` | GET | `/api/v1/overview` |  |
| `vibeletter newsletters list` | GET | `/api/v1/newsletters` | {items,total,limit,offset} |
| `vibeletter newsletters get` | GET | `/api/v1/newsletters/[id]` |  |
| `vibeletter newsletters create` | POST | `/api/v1/newsletters` |  |
| `vibeletter newsletters update` | PATCH | `/api/v1/newsletters/[id]` |  |
| `vibeletter newsletters delete` | DELETE | `/api/v1/newsletters/[id]` |  |
| `vibeletter newsletters welcome-test` | POST | `/api/v1/newsletters/[id]/actions` | action=welcome-test.  |
| `vibeletter contacts list` | GET | `/api/v1/contacts` | {items,total,limit,offset} |
| `vibeletter contacts get` | GET | `/api/v1/contacts/[id]` |  |
| `vibeletter contacts create` | POST | `/api/v1/contacts` |  |
| `vibeletter contacts update` | PATCH | `/api/v1/contacts/[id]` |  |
| `vibeletter contacts delete` | DELETE | `/api/v1/contacts/[id]` |  |
| `vibeletter contacts status` | POST | `/api/v1/contacts/[id]/status` | JSON {status:active|unsubscribed} |
| `vibeletter contacts import` | POST | `/api/v1/contacts/import` | JSON {newsletter,rows,source?}, sequential batches, no retry |
| `vibeletter contacts export` | GET | `/api/v1/contacts/export` | format=json, all pages, CSV encoded locally, JSON preserves all record fields |
| `vibeletter campaigns list` | GET | `/api/v1/campaigns` | {items,total,limit,offset,issues,issuesTotal,issuesLimit,issuesOffset}; --all reads both collections independently |
| `vibeletter campaigns get` | GET | `/api/v1/campaigns/[id]` |  |
| `vibeletter campaigns create` | POST | `/api/v1/campaigns` |  |
| `vibeletter campaigns update` | PATCH | `/api/v1/campaigns/[id]` |  |
| `vibeletter campaigns delete` | DELETE | `/api/v1/campaigns/[id]` |  |
| `vibeletter campaigns test` | POST | `/api/v1/campaigns/[id]/actions` | action=test. JSON {action,...options} |
| `vibeletter campaigns send` | POST | `/api/v1/campaigns/[id]/actions` | action=send. JSON {action,...options} |
| `vibeletter campaigns schedule` | POST | `/api/v1/campaigns/[id]/actions` | action=schedule. JSON {action,...options} |
| `vibeletter campaigns unschedule` | POST | `/api/v1/campaigns/[id]/actions` | action=unschedule. JSON {action,...options} |
| `vibeletter campaigns pause` | POST | `/api/v1/campaigns/[id]/actions` | action=pause. JSON {action,...options} |
| `vibeletter campaigns resume` | POST | `/api/v1/campaigns/[id]/actions` | action=resume. JSON {action,...options} |
| `vibeletter campaigns send-more` | POST | `/api/v1/campaigns/[id]/actions` | action=send-more. JSON {action,...options} |
| `vibeletter campaigns duplicate` | POST | `/api/v1/campaigns/[id]/actions` | action=duplicate. JSON {action,...options} |
| `vibeletter campaigns pin` | POST | `/api/v1/campaigns/[id]/actions` | action=pin. JSON {action,...options} |
| `vibeletter campaigns archive-slug` | POST | `/api/v1/campaigns/[id]/actions` | action=archive-slug. JSON {action,...options} |
| `vibeletter campaigns discard` | POST | `/api/v1/campaigns/[id]/actions` | action=discard. JSON {action,...options} |
| `vibeletter campaigns cleanup-preview` | POST | `/api/v1/campaigns/[id]/actions` | action=cleanup-preview. JSON {action,...options} |
| `vibeletter campaigns preview` | GET | `/api/v1/campaigns/[id]/preview` |  |
| `vibeletter campaigns report` | GET | `/api/v1/campaigns/[id]/report` |  |
| `vibeletter domains list` | GET | `/api/v1/domains` | {items,total,limit,offset} |
| `vibeletter domains account` | GET | `/api/v1/domains/account` |  |
| `vibeletter domains get` | GET | `/api/v1/domains/[domain]` |  |
| `vibeletter domains dns` | GET | `/api/v1/domains/[domain]/dns` |  |
| `vibeletter domains create` | POST | `/api/v1/domains` |  |
| `vibeletter domains verify` | POST | `/api/v1/domains/[domain]/verify` |  |
| `vibeletter keys list` | GET | `/api/v1/api-keys` | {items,total,limit,offset} |
| `vibeletter keys get` | GET | `/api/v1/api-keys/[id]` |  |
| `vibeletter keys create` | POST | `/api/v1/api-keys` |  |
| `vibeletter keys revoke` | DELETE | `/api/v1/api-keys/[id]` |  |
| `vibeletter suppressions list` | GET | `/api/v1/suppressions` | {items,total,limit,offset} |
| `vibeletter suppressions get` | GET | `/api/v1/suppressions/[id]` |  |
| `vibeletter suppressions add` | POST | `/api/v1/suppressions` |  |
| `vibeletter suppressions remove` | DELETE | `/api/v1/suppressions/[id]` |  |
| `vibeletter queue list` | GET | `/api/v1/queue` | {items,total,limit,offset} |
| `vibeletter queue get` | GET | `/api/v1/queue/[id]` |  |
| `vibeletter queue retry` | POST | `/api/v1/queue/[id]/retry` |  |
| `vibeletter queue cancel` | POST | `/api/v1/queue/[id]/cancel` |  |
| `vibeletter uploads create` | POST | `/api/v1/uploads` | raw image bytes, image Content-Type, X-File-Name, no multipart |

## Vollständige Befehlsreferenz

### vibeletter

```text
Usage: vibeletter [options] [command]

VibeLetter Operator-CLI mit privaten Kontextprofilen

Options:
  -V, --version       Versionsnummer ausgeben
  --context <name>    Kontext für diesen Aufruf wählen
  --instance <url>    App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json              Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>      HTTP-Zeitlimit in Millisekunden (default: 30000)
  -h, --help          Hilfe zum Befehl anzeigen

Commands:
  context             Private Kontextprofile verwalten
  catalog             Maschinenlesbare Befehle, Optionen und HTTP-Verträge ohne
                      Netzwerk lesen
  health              Authentifizierte API-Readiness lesen
  readiness           Öffentliche Readiness ohne Token lesen
  overview [options]  Operator-Übersicht lesen
  newsletters         Newsletter mit originalen Feldern verwalten
  contacts            Kontakte verwalten, Import sendet keine Willkommensmail
  campaigns           Kampagnen und Versandaktionen verwalten
  domains             SES-Absenderdomains und DNS verwalten
  keys                API-Schlüssel mit Scopes und Ablauf verwalten
  suppressions        Globale Versandsperren verwalten
  queue               Persistente Sender-Aufträge prüfen
  uploads             Dateien über den konfigurierten Upload-Provider speichern
  help [command]      Hilfe zu einem Befehl anzeigen

Tokens: VIBELETTER_TOKEN, context set --token-file oder --token-stdin. Kein Token-Argument.
Hilfe zu jedem Befehl: vibeletter <Befehl> --help
```

### vibeletter context

```text
Usage: vibeletter context [options] [command]

Private Kontextprofile verwalten

Options:
  -h, --help               Hilfe zum Befehl anzeigen

Global Options:
  -V, --version            Versionsnummer ausgeben
  --context <name>         Kontext für diesen Aufruf wählen
  --instance <url>         App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                   Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>           HTTP-Zeitlimit in Millisekunden (default: 30000)

Commands:
  set [options] <name>     Kontext anlegen oder ersetzen, Token nie als Argument
  use [options] <name>     Standardkontext wählen
  list [options]           Kontexte auflisten, Tokens immer schwärzen
  show [options] [name]    Kontext oder effektive Auswahl mit Token-Herkunft
                           lesen
  remove [options] <name>  Kontext und seine gespeicherten Zugangsdaten
                           entfernen
  verify [options] [name]  Health und authentifizierten API-Zugriff real prüfen
  help [command]           Hilfe zu einem Befehl anzeigen
```

### vibeletter context set

```text
Usage: vibeletter context set [options] <name>

Kontext anlegen oder ersetzen, Token nie als Argument

Options:
  --instance <url>     App-URL des Kontextes, erforderlich
  --token-stdin        Token aus stdin lesen
  --token-file <path>  Token aus eigener Datei mit Dateirechten 0600 lesen
  --token-env <name>   Token aus benannter Umgebungsvariable lesen
  --clear-token        Gespeichertes Token entfernen
  --scope <scope>      Konfigurationsdatei: global oder local (default:
                       "global")
  -h, --help           Hilfe zum Befehl anzeigen

Global Options:
  -V, --version        Versionsnummer ausgeben
  --context <name>     Kontext für diesen Aufruf wählen
  --instance <url>     App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json               Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>       HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter context use

```text
Usage: vibeletter context use [options] <name>

Standardkontext wählen

Options:
  --scope <scope>   Konfigurationsdatei: global oder local (default: "global")
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter context list

```text
Usage: vibeletter context list [options]

Kontexte auflisten, Tokens immer schwärzen

Options:
  --scope <scope>   Nur global oder local lesen
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter context show

```text
Usage: vibeletter context show [options] [name]

Kontext oder effektive Auswahl mit Token-Herkunft lesen

Options:
  --scope <scope>   Nur global oder local lesen
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter context remove

```text
Usage: vibeletter context remove [options] <name>

Kontext und seine gespeicherten Zugangsdaten entfernen

Options:
  --scope <scope>   Konfigurationsdatei: global oder local (default: "global")
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter context verify

```text
Usage: vibeletter context verify [options] [name]

Health und authentifizierten API-Zugriff real prüfen

Options:
  --scope <scope>   Nur global oder local lesen
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter catalog

```text
Usage: vibeletter catalog [options]

Maschinenlesbare Befehle, Optionen und HTTP-Verträge ohne Netzwerk lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter health

```text
Usage: vibeletter health [options]

Authentifizierte API-Readiness lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter readiness

```text
Usage: vibeletter readiness [options]

Öffentliche Readiness ohne Token lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter overview

```text
Usage: vibeletter overview [options]

Operator-Übersicht lesen

Options:
  --newsletter <slug>  Newsletter-Slug
  --time-zone <value>  IANA-Zeitzone des Berichts
  -h, --help           Hilfe zum Befehl anzeigen

Global Options:
  -V, --version        Versionsnummer ausgeben
  --context <name>     Kontext für diesen Aufruf wählen
  --instance <url>     App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json               Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>       HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter newsletters

```text
Usage: vibeletter newsletters [options] [command]

Newsletter mit originalen Feldern verwalten

Options:
  -h, --help                   Hilfe zum Befehl anzeigen

Global Options:
  -V, --version                Versionsnummer ausgeben
  --context <name>             Kontext für diesen Aufruf wählen
  --instance <url>             App-URL für diesen Aufruf, vor Kontext und
                               Umgebung
  --json                       Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>               HTTP-Zeitlimit in Millisekunden (default: 30000)

Commands:
  list [options]               Einträge mit Paginierung auflisten
  get <id>                     Eintrag anhand seiner ID lesen
  create [options]             Eintrag anlegen und die API-Antwort ausgeben
  update [options] <id>        Angegebene Felder mit PATCH ändern
  delete [options] <id>        Eintrag löschen, API prüft vorhandene Beziehungen
  welcome-test [options] <id>  Willkommensmail über den gemeinsamen Sender
                               testen
  help [command]               Hilfe zu einem Befehl anzeigen
```

### vibeletter newsletters list

```text
Usage: vibeletter newsletters list [options]

Einträge mit Paginierung auflisten

Options:
  --limit <number>   Seitengröße, 1 bis 100 (default: 50)
  --offset <number>  Erster Eintrag, ab 0 (default: 0)
  --all              Alle Seiten lesen, total und eindeutige IDs prüfen
  -h, --help         Hilfe zum Befehl anzeigen

Global Options:
  -V, --version      Versionsnummer ausgeben
  --context <name>   Kontext für diesen Aufruf wählen
  --instance <url>   App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json             Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>     HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter newsletters get

```text
Usage: vibeletter newsletters get [options] <id>

Eintrag anhand seiner ID lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter newsletters create

```text
Usage: vibeletter newsletters create [options]

Eintrag anlegen und die API-Antwort ausgeben

Options:
  --file <path>             JSON-Objekt aus Datei, - liest stdin
  --name <value>            Name des Newsletters
  --slug <value>            Newsletter-Slug
  --from-name <value>       Absendername
  --from-email <value>      Absenderadresse
  --reply-to <value>        Antwortadresse
  --postal-address <value>  Postanschrift
  -h, --help                Hilfe zum Befehl anzeigen

Global Options:
  -V, --version             Versionsnummer ausgeben
  --context <name>          Kontext für diesen Aufruf wählen
  --instance <url>          App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                    Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>            HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter newsletters update

```text
Usage: vibeletter newsletters update [options] <id>

Angegebene Felder mit PATCH ändern

Options:
  --file <path>             JSON-Objekt aus Datei, - liest stdin
  --name <value>            Name des Newsletters
  --slug <value>            Newsletter-Slug
  --from-name <value>       Absendername
  --from-email <value>      Absenderadresse
  --reply-to <value>        Antwortadresse
  --postal-address <value>  Postanschrift
  -h, --help                Hilfe zum Befehl anzeigen

Global Options:
  -V, --version             Versionsnummer ausgeben
  --context <name>          Kontext für diesen Aufruf wählen
  --instance <url>          App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                    Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>            HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter newsletters delete

```text
Usage: vibeletter newsletters delete [options] <id>

Eintrag löschen, API prüft vorhandene Beziehungen

Options:
  --confirm         Löschen ausdrücklich bestätigen
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter newsletters welcome-test

```text
Usage: vibeletter newsletters welcome-test [options] <id>

Willkommensmail über den gemeinsamen Sender testen

Options:
  --to <email>      Testempfänger, sonst ADMIN_EMAIL
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter contacts

```text
Usage: vibeletter contacts [options] [command]

Kontakte verwalten, Import sendet keine Willkommensmail

Options:
  -h, --help             Hilfe zum Befehl anzeigen

Global Options:
  -V, --version          Versionsnummer ausgeben
  --context <name>       Kontext für diesen Aufruf wählen
  --instance <url>       App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                 Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>         HTTP-Zeitlimit in Millisekunden (default: 30000)

Commands:
  list [options]         Einträge mit Paginierung auflisten
  get <id>               Eintrag anhand seiner ID lesen
  create [options]       Eintrag anlegen und die API-Antwort ausgeben
  update [options] <id>  Angegebene Felder mit PATCH ändern
  delete [options] <id>  Eintrag löschen, API prüft vorhandene Beziehungen
  status <id> <status>   Kontaktstatus ändern, active reaktiviert nur dormant
  import [options]       CSV oder JSON vollständig lesen und in höchstens 1000
                         Zeilen je Anfrage importieren
  export [options]       Alle Kontakte mit überprüfter Paginierung als CSV oder
                         JSON exportieren
  help [command]         Hilfe zu einem Befehl anzeigen
```

### vibeletter contacts list

```text
Usage: vibeletter contacts list [options]

Einträge mit Paginierung auflisten

Options:
  --limit <number>     Seitengröße, 1 bis 100 (default: 50)
  --offset <number>    Erster Eintrag, ab 0 (default: 0)
  --all                Alle Seiten lesen, total und eindeutige IDs prüfen
  --newsletter <slug>  Nach Newsletter-Slug filtern
  --status <value>     Nach Status filtern
  --search <text>      Suchtext, HTTP-Feld q
  --email <value>      Nach E-Mail-Adresse filtern
  -h, --help           Hilfe zum Befehl anzeigen

Global Options:
  -V, --version        Versionsnummer ausgeben
  --context <name>     Kontext für diesen Aufruf wählen
  --instance <url>     App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json               Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>       HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter contacts get

```text
Usage: vibeletter contacts get [options] <id>

Eintrag anhand seiner ID lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter contacts create

```text
Usage: vibeletter contacts create [options]

Eintrag anlegen und die API-Antwort ausgeben

Options:
  --file <path>          JSON-Objekt aus Datei, - liest stdin
  --newsletter <value>   Newsletter-Slug, keine ID
  --email <value>        E-Mail-Adresse
  --source <value>       Herkunft
  --resubscribe <value>  Erneute Anmeldung: true oder false
  --ip <value>           Besucher-IP für das API-Rate-Limit
  -h, --help             Hilfe zum Befehl anzeigen

Global Options:
  -V, --version          Versionsnummer ausgeben
  --context <name>       Kontext für diesen Aufruf wählen
  --instance <url>       App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                 Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>         HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter contacts update

```text
Usage: vibeletter contacts update [options] <id>

Angegebene Felder mit PATCH ändern

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  --source <value>  Herkunft
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter contacts delete

```text
Usage: vibeletter contacts delete [options] <id>

Eintrag löschen, API prüft vorhandene Beziehungen

Options:
  --confirm         Löschen ausdrücklich bestätigen
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter contacts status

```text
Usage: vibeletter contacts status [options] <id> <status>

Kontaktstatus ändern, active reaktiviert nur dormant

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter contacts import

```text
Usage: vibeletter contacts import [options]

CSV oder JSON vollständig lesen und in höchstens 1000 Zeilen je Anfrage
importieren

Options:
  --file <path>          CSV-Datei oder JSON-Objekt mit rows, - liest stdin
  --format <format>      csv oder json (default: "csv")
  --newsletter <slug>    Newsletter-Slug, bei CSV erforderlich
  --source <value>       Import-Herkunft
  --batch-size <number>  Zeilen pro HTTP-Anfrage, 1 bis 1000 (default: 1000)
  -h, --help             Hilfe zum Befehl anzeigen

Global Options:
  -V, --version          Versionsnummer ausgeben
  --context <name>       Kontext für diesen Aufruf wählen
  --instance <url>       App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                 Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>         HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter contacts export

```text
Usage: vibeletter contacts export [options]

Alle Kontakte mit überprüfter Paginierung als CSV oder JSON exportieren

Options:
  --newsletter <slug>  Nach Newsletter-Slug filtern
  --status <value>     Nach Status filtern
  --email <value>      Nach E-Mail-Adresse filtern
  --search <text>      Suchtext, HTTP-Feld q
  --format <format>    csv oder json (default: "csv")
  --out <path>         Privat und atomar speichern, - schreibt stdout
  --raw-csv            Formelschutz deaktivieren, nur für maschinellen Reimport
  -h, --help           Hilfe zum Befehl anzeigen

Global Options:
  -V, --version        Versionsnummer ausgeben
  --context <name>     Kontext für diesen Aufruf wählen
  --instance <url>     App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json               Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>       HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns

```text
Usage: vibeletter campaigns [options] [command]

Kampagnen und Versandaktionen verwalten

Options:
  -h, --help                      Hilfe zum Befehl anzeigen

Global Options:
  -V, --version                   Versionsnummer ausgeben
  --context <name>                Kontext für diesen Aufruf wählen
  --instance <url>                App-URL für diesen Aufruf, vor Kontext und
                                  Umgebung
  --json                          Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>                  HTTP-Zeitlimit in Millisekunden (default:
                                  30000)

Commands:
  list [options]                  Einträge mit Paginierung auflisten
  get <id>                        Eintrag anhand seiner ID lesen
  create [options]                Eintrag anlegen und die API-Antwort ausgeben
  update [options] <id>           Angegebene Felder mit PATCH ändern
  delete [options] <id>           Entwurf verwerfen, kein physisches Löschen
  test [options] <id>             Testsendung über den gemeinsamen Sender
                                  anfordern
  send [options] <id>             Versand starten, nicht automatisch wiederholen
  schedule [options] <id>         Versand für einen Zeitpunkt mit Zeitzone
                                  planen
  unschedule [options] <id>       Geplanten Versand aufheben
  pause [options] <id>            Laufenden Versand pausieren
  resume [options] <id>           Pausierten Versand fortsetzen
  send-more [options] <id>        Noch nicht erreichte Kontakte anschreiben
  duplicate [options] <id>        Neuen Entwurf aus dieser Kampagne anlegen
  pin [options] <id>              Archiv-Pin ausdrücklich setzen oder entfernen
  archive-slug [options] <id>     Archiv-Slug setzen, leere Zeichenfolge
                                  entfernt einen Entwurfs-Slug
  discard [options] <id>          Entwurf verwerfen und geplanten Versand
                                  stoppen
  cleanup-preview [options] <id>  Listenbereinigung berechnen, ohne Versand
  preview [options] <id>          Gerendertes HTML lesen
  report [options] <id>           Versand- und Ereignisbericht lesen
  help [command]                  Hilfe zu einem Befehl anzeigen
```

### vibeletter campaigns list

```text
Usage: vibeletter campaigns list [options]

Einträge mit Paginierung auflisten

Options:
  --limit <number>     Seitengröße, 1 bis 100 (default: 50)
  --offset <number>    Erster Eintrag, ab 0 (default: 0)
  --all                Alle Seiten lesen, total und eindeutige IDs prüfen
  --newsletter <slug>  Nach Newsletter-Slug filtern
  --status <value>     Nach Status filtern
  -h, --help           Hilfe zum Befehl anzeigen

Global Options:
  -V, --version        Versionsnummer ausgeben
  --context <name>     Kontext für diesen Aufruf wählen
  --instance <url>     App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json               Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>       HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns get

```text
Usage: vibeletter campaigns get [options] <id>

Eintrag anhand seiner ID lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns create

```text
Usage: vibeletter campaigns create [options]

Eintrag anlegen und die API-Antwort ausgeben

Options:
  --file <path>             JSON-Objekt aus Datei, - liest stdin
  --newsletter <value>      Newsletter-Slug, keine ID
  --subject <value>         Betreff
  --preview-text <value>    Vorschautext
  --archive-slug <value>    Archiv-Slug
  --format <value>          html, markdown oder rich
  --audience-limit <value>  Maximale Zielgruppe
  --archive-listed <value>  Im Archiv auflisten: true oder false
  --html-file <path>        HTML aus Datei, - liest stdin
  --markdown-file <path>    Markdown aus Datei, - liest stdin
  -h, --help                Hilfe zum Befehl anzeigen

Global Options:
  -V, --version             Versionsnummer ausgeben
  --context <name>          Kontext für diesen Aufruf wählen
  --instance <url>          App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                    Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>            HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns update

```text
Usage: vibeletter campaigns update [options] <id>

Angegebene Felder mit PATCH ändern

Options:
  --file <path>             JSON-Objekt aus Datei, - liest stdin
  --subject <value>         Betreff
  --preview-text <value>    Vorschautext
  --archive-slug <value>    Archiv-Slug
  --format <value>          html, markdown oder rich
  --audience-limit <value>  Maximale Zielgruppe
  --archive-listed <value>  Im Archiv auflisten: true oder false
  --html-file <path>        HTML aus Datei, - liest stdin
  --markdown-file <path>    Markdown aus Datei, - liest stdin
  -h, --help                Hilfe zum Befehl anzeigen

Global Options:
  -V, --version             Versionsnummer ausgeben
  --context <name>          Kontext für diesen Aufruf wählen
  --instance <url>          App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                    Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>            HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns delete

```text
Usage: vibeletter campaigns delete [options] <id>

Entwurf verwerfen, kein physisches Löschen

Options:
  --confirm         Löschen ausdrücklich bestätigen
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns test

```text
Usage: vibeletter campaigns test [options] <id>

Testsendung über den gemeinsamen Sender anfordern

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  --to <value>      Testempfänger
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns send

```text
Usage: vibeletter campaigns send [options] <id>

Versand starten, nicht automatisch wiederholen

Options:
  --file <path>             JSON-Objekt aus Datei, - liest stdin
  --audience-limit <value>  Maximale Zielgruppe
  -h, --help                Hilfe zum Befehl anzeigen

Global Options:
  -V, --version             Versionsnummer ausgeben
  --context <name>          Kontext für diesen Aufruf wählen
  --instance <url>          App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                    Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>            HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns schedule

```text
Usage: vibeletter campaigns schedule [options] <id>

Versand für einen Zeitpunkt mit Zeitzone planen

Options:
  --file <path>             JSON-Objekt aus Datei, - liest stdin
  --at <value>              ISO-8601-Zeitpunkt mit Z oder UTC-Offset
  --audience-limit <value>  Maximale Zielgruppe
  -h, --help                Hilfe zum Befehl anzeigen

Global Options:
  -V, --version             Versionsnummer ausgeben
  --context <name>          Kontext für diesen Aufruf wählen
  --instance <url>          App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                    Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>            HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns unschedule

```text
Usage: vibeletter campaigns unschedule [options] <id>

Geplanten Versand aufheben

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns pause

```text
Usage: vibeletter campaigns pause [options] <id>

Laufenden Versand pausieren

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns resume

```text
Usage: vibeletter campaigns resume [options] <id>

Pausierten Versand fortsetzen

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns send-more

```text
Usage: vibeletter campaigns send-more [options] <id>

Noch nicht erreichte Kontakte anschreiben

Options:
  --file <path>         JSON-Objekt aus Datei, - liest stdin
  --additional <value>  Zusätzliche Kontakte, ohne Wert alle verbleibenden
  -h, --help            Hilfe zum Befehl anzeigen

Global Options:
  -V, --version         Versionsnummer ausgeben
  --context <name>      Kontext für diesen Aufruf wählen
  --instance <url>      App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>        HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns duplicate

```text
Usage: vibeletter campaigns duplicate [options] <id>

Neuen Entwurf aus dieser Kampagne anlegen

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns pin

```text
Usage: vibeletter campaigns pin [options] <id>

Archiv-Pin ausdrücklich setzen oder entfernen

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  --value <value>   true oder false
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns archive-slug

```text
Usage: vibeletter campaigns archive-slug [options] <id>

Archiv-Slug setzen, leere Zeichenfolge entfernt einen Entwurfs-Slug

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  --slug <value>    Neuer Archiv-Slug
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns discard

```text
Usage: vibeletter campaigns discard [options] <id>

Entwurf verwerfen und geplanten Versand stoppen

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns cleanup-preview

```text
Usage: vibeletter campaigns cleanup-preview [options] <id>

Listenbereinigung berechnen, ohne Versand

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns preview

```text
Usage: vibeletter campaigns preview [options] <id>

Gerendertes HTML lesen

Options:
  --out <path>      HTML privat und atomar speichern
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter campaigns report

```text
Usage: vibeletter campaigns report [options] <id>

Versand- und Ereignisbericht lesen

Options:
  --out <path>       JSON privat und atomar speichern
  --limit <number>   Nachrichten und Ereignisse je Sammlung und Seite, 1 bis 100
                     (default: 50)
  --offset <number>  Erster Eintrag jeder Sammlung, ab 0 (default: 0)
  -h, --help         Hilfe zum Befehl anzeigen

Global Options:
  -V, --version      Versionsnummer ausgeben
  --context <name>   Kontext für diesen Aufruf wählen
  --instance <url>   App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json             Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>     HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter domains

```text
Usage: vibeletter domains [options] [command]

SES-Absenderdomains und DNS verwalten

Options:
  -h, --help                 Hilfe zum Befehl anzeigen

Global Options:
  -V, --version              Versionsnummer ausgeben
  --context <name>           Kontext für diesen Aufruf wählen
  --instance <url>           App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                     Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>             HTTP-Zeitlimit in Millisekunden (default: 30000)

Commands:
  list [options]             Einträge mit Paginierung auflisten
  account                    SES-Account, Quoten und Versandfreigabe frisch
                             lesen
  get <domain>               Domain und DNS-Einträge lesen
  dns <domain>               DNS-Anforderungen der Domain lesen
  create [options]           Domain anlegen und echte DNS-Anforderungen ausgeben
  verify [options] <domain>  Domain-Verifikation beim Provider neu prüfen
  help [command]             Hilfe zu einem Befehl anzeigen
```

### vibeletter domains list

```text
Usage: vibeletter domains list [options]

Einträge mit Paginierung auflisten

Options:
  --limit <number>   Seitengröße, 1 bis 100 (default: 50)
  --offset <number>  Erster Eintrag, ab 0 (default: 0)
  --all              Alle Seiten lesen, total und eindeutige IDs prüfen
  -h, --help         Hilfe zum Befehl anzeigen

Global Options:
  -V, --version      Versionsnummer ausgeben
  --context <name>   Kontext für diesen Aufruf wählen
  --instance <url>   App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json             Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>     HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter domains account

```text
Usage: vibeletter domains account [options]

SES-Account, Quoten und Versandfreigabe frisch lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter domains get

```text
Usage: vibeletter domains get [options] <domain>

Domain und DNS-Einträge lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter domains dns

```text
Usage: vibeletter domains dns [options] <domain>

DNS-Anforderungen der Domain lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter domains create

```text
Usage: vibeletter domains create [options]

Domain anlegen und echte DNS-Anforderungen ausgeben

Options:
  --file <path>                     JSON-Objekt aus Datei, - liest stdin
  --domain <value>                  Absenderdomain
  --mail-from-domain <value>        MAIL-FROM-Subdomain
  --configuration-set-name <value>  SES-Konfigurationsset
  -h, --help                        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version                     Versionsnummer ausgeben
  --context <name>                  Kontext für diesen Aufruf wählen
  --instance <url>                  App-URL für diesen Aufruf, vor Kontext und
                                    Umgebung
  --json                            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>                    HTTP-Zeitlimit in Millisekunden (default:
                                    30000)
```

### vibeletter domains verify

```text
Usage: vibeletter domains verify [options] <domain>

Domain-Verifikation beim Provider neu prüfen

Options:
  --file <path>                   JSON-Objekt aus Datei, - liest stdin
  --mail-from-domain <value>      MAIL-FROM-Subdomain
  --dkim-signing-enabled <value>  DKIM-Signierung: true oder false
  -h, --help                      Hilfe zum Befehl anzeigen

Global Options:
  -V, --version                   Versionsnummer ausgeben
  --context <name>                Kontext für diesen Aufruf wählen
  --instance <url>                App-URL für diesen Aufruf, vor Kontext und
                                  Umgebung
  --json                          Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>                  HTTP-Zeitlimit in Millisekunden (default:
                                  30000)
```

### vibeletter keys

```text
Usage: vibeletter keys [options] [command]

API-Schlüssel mit Scopes und Ablauf verwalten

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)

Commands:
  list [options]    Einträge mit Paginierung auflisten
  get <id>          Schlüssel-Metadaten lesen, nie Klartext
  create [options]  Schlüssel anlegen, Klartext nur in dieser API-Antwort
  revoke <id>       Schlüssel widerrufen
  help [command]    Hilfe zu einem Befehl anzeigen
```

### vibeletter keys list

```text
Usage: vibeletter keys list [options]

Einträge mit Paginierung auflisten

Options:
  --limit <number>   Seitengröße, 1 bis 100 (default: 50)
  --offset <number>  Erster Eintrag, ab 0 (default: 0)
  --all              Alle Seiten lesen, total und eindeutige IDs prüfen
  -h, --help         Hilfe zum Befehl anzeigen

Global Options:
  -V, --version      Versionsnummer ausgeben
  --context <name>   Kontext für diesen Aufruf wählen
  --instance <url>   App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json             Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>     HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter keys get

```text
Usage: vibeletter keys get [options] <id>

Schlüssel-Metadaten lesen, nie Klartext

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter keys create

```text
Usage: vibeletter keys create [options]

Schlüssel anlegen, Klartext nur in dieser API-Antwort

Options:
  --out <path>          Vollständige Erstellungsantwort privat speichern statt
                        stdout
  --file <path>         JSON-Objekt aus Datei, - liest stdin
  --name <value>        Schlüsselname
  --scopes <value>      Scopes durch Kommas getrennt, explizit erforderlich
  --expires-at <value>  ISO-8601-Ablaufzeit
  -h, --help            Hilfe zum Befehl anzeigen

Global Options:
  -V, --version         Versionsnummer ausgeben
  --context <name>      Kontext für diesen Aufruf wählen
  --instance <url>      App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>        HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter keys revoke

```text
Usage: vibeletter keys revoke [options] <id>

Schlüssel widerrufen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter suppressions

```text
Usage: vibeletter suppressions [options] [command]

Globale Versandsperren verwalten

Options:
  -h, --help             Hilfe zum Befehl anzeigen

Global Options:
  -V, --version          Versionsnummer ausgeben
  --context <name>       Kontext für diesen Aufruf wählen
  --instance <url>       App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                 Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>         HTTP-Zeitlimit in Millisekunden (default: 30000)

Commands:
  list [options]         Einträge mit Paginierung auflisten
  get <id>               Globale Versandsperre lesen
  add [options]          Adresse global sperren
  remove [options] <id>  Globale Sperre entfernen, Kontaktstatus bleibt
                         serverseitig geschützt
  help [command]         Hilfe zu einem Befehl anzeigen
```

### vibeletter suppressions list

```text
Usage: vibeletter suppressions list [options]

Einträge mit Paginierung auflisten

Options:
  --limit <number>   Seitengröße, 1 bis 100 (default: 50)
  --offset <number>  Erster Eintrag, ab 0 (default: 0)
  --all              Alle Seiten lesen, total und eindeutige IDs prüfen
  --reason <value>   Nach Sperrgrund filtern
  --email <value>    Nach E-Mail-Adresse filtern
  -h, --help         Hilfe zum Befehl anzeigen

Global Options:
  -V, --version      Versionsnummer ausgeben
  --context <name>   Kontext für diesen Aufruf wählen
  --instance <url>   App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json             Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>     HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter suppressions get

```text
Usage: vibeletter suppressions get [options] <id>

Globale Versandsperre lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter suppressions add

```text
Usage: vibeletter suppressions add [options]

Adresse global sperren

Options:
  --file <path>     JSON-Objekt aus Datei, - liest stdin
  --email <value>   Gesperrte E-Mail-Adresse
  --reason <value>  Sperrgrund
  --detail <value>  Zusätzliche Angabe
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter suppressions remove

```text
Usage: vibeletter suppressions remove [options] <id>

Globale Sperre entfernen, Kontaktstatus bleibt serverseitig geschützt

Options:
  --confirm         Entfernen dieser globalen Sperre ausdrücklich bestätigen
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter queue

```text
Usage: vibeletter queue [options] [command]

Persistente Sender-Aufträge prüfen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)

Commands:
  list [options]    Einträge mit Paginierung auflisten
  get <id>          Auftrag anhand seiner positiven Dezimal-ID lesen
  retry <id>        Fehlgeschlagenen Auftrag erneut anfordern, API verweigert
                    unklare oder bereits akzeptierte Zustellung
  cancel <id>       Auftrag abbrechen
  help [command]    Hilfe zu einem Befehl anzeigen
```

### vibeletter queue list

```text
Usage: vibeletter queue list [options]

Einträge mit Paginierung auflisten

Options:
  --limit <number>   Seitengröße, 1 bis 100 (default: 50)
  --offset <number>  Erster Eintrag, ab 0 (default: 0)
  --all              Alle Seiten lesen, total und eindeutige IDs prüfen
  --status <value>   Nach Status filtern
  -h, --help         Hilfe zum Befehl anzeigen

Global Options:
  -V, --version      Versionsnummer ausgeben
  --context <name>   Kontext für diesen Aufruf wählen
  --instance <url>   App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json             Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>     HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter queue get

```text
Usage: vibeletter queue get [options] <id>

Auftrag anhand seiner positiven Dezimal-ID lesen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter queue retry

```text
Usage: vibeletter queue retry [options] <id>

Fehlgeschlagenen Auftrag erneut anfordern, API verweigert unklare oder bereits
akzeptierte Zustellung

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter queue cancel

```text
Usage: vibeletter queue cancel [options] <id>

Auftrag abbrechen

Options:
  -h, --help        Hilfe zum Befehl anzeigen

Global Options:
  -V, --version     Versionsnummer ausgeben
  --context <name>  Kontext für diesen Aufruf wählen
  --instance <url>  App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json            Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>    HTTP-Zeitlimit in Millisekunden (default: 30000)
```

### vibeletter uploads

```text
Usage: vibeletter uploads [options] [command]

Dateien über den konfigurierten Upload-Provider speichern

Options:
  -h, --help               Hilfe zum Befehl anzeigen

Global Options:
  -V, --version            Versionsnummer ausgeben
  --context <name>         Kontext für diesen Aufruf wählen
  --instance <url>         App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json                   Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>           HTTP-Zeitlimit in Millisekunden (default: 30000)

Commands:
  create [options] <file>  Bildbytes aus Datei oder stdin hochladen, höchstens 4
                           MiB
  help [command]           Hilfe zu einem Befehl anzeigen
```

### vibeletter uploads create

```text
Usage: vibeletter uploads create [options] <file>

Bildbytes aus Datei oder stdin hochladen, höchstens 4 MiB

Options:
  --mime <type>      Expliziter MIME-Typ, sonst aus Dateiendung
  --name <filename>  Dateiname, bei stdin erforderlich
  -h, --help         Hilfe zum Befehl anzeigen

Global Options:
  -V, --version      Versionsnummer ausgeben
  --context <name>   Kontext für diesen Aufruf wählen
  --instance <url>   App-URL für diesen Aufruf, vor Kontext und Umgebung
  --json             Kompaktes JSON, Fehler als JSON auf stderr
  --timeout <ms>     HTTP-Zeitlimit in Millisekunden (default: 30000)
```
