import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createProgram } from '../dist/commands.js';
import { buildCatalog, commandEntries } from '../dist/catalog.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(cli, '../..');
const bin = path.join(cli, 'dist/index.js');
const program = createProgram();
const entries = commandEntries(program);
const catalog = buildCatalog(program);

const intro = `# VibeLetter CLI

Diese Datei und die beiden llms-Dateien entstehen aus dem echten Commander-Befehlsbaum und ausgeführtem --help. Ändere den Befehlsbaum oder diesen Generator, nicht die generierten Hilfeblöcke.

## Starten

Node.js 24 oder neuer. Im Quellrepository:

\`\`\`sh
npm run build --workspace @vibelabsdotto/vibeletter-cli
node apps/cli/dist/index.js --help
npm run cli -- --help
node apps/cli/dist/index.js catalog --json
\`\`\`

Das npm-Paket heißt @vibelabsdotto/vibeletter-cli, das ausführbare Programm vibeletter. npm link --workspace @vibelabsdotto/vibeletter-cli kann den bereits gebauten Workspace lokal verlinken. Eine globale Veröffentlichung ist dafür nicht nötig.

Der Root-Wrapper verwendet den gebauten Bin direkt und behält das Repository als Arbeitsverzeichnis. Damit bleibt .vibeletter/config.json im Repository der lokale Kontext. Baue die CLI vor dem ersten Aufruf. Für reine JSON-Ausgabe über npm: npm run --silent cli -- --json readiness.

## Kontexte und Tokens

Globale Datei: ~/.config/vibeletter/config.json. Lokale Datei: .vibeletter/config.json im aktuellen Arbeitsverzeichnis. Schreiboperationen verwenden standardmäßig --scope global. Ein ausdrückliches --scope local oder --scope global liest nur diese Datei, ohne Kontext- oder Credential-Fallback auf die andere Datei. Verzeichnisse haben Modus 0700, Dateien Modus 0600. Der CLI ersetzt Dateien per atomarem Rename nach fsync. Symlinks und unsichere Token-Dateien werden abgewiesen. Ungültige Konfiguration wird nicht stillschweigend überschrieben.

\`\`\`sh
vibeletter context set development --instance http://localhost:3035 --scope local --token-file /private/path/operator.token
vibeletter context use development --scope local
vibeletter context list --json
vibeletter context show --json
vibeletter context verify development --scope local --json
vibeletter context set production --instance https://letters.example.com --token-stdin < /private/path/operator.token
vibeletter context use production
vibeletter readiness --instance http://localhost:3035 --json
\`\`\`

Kein Token steht im Argumentvektor. --token-env nennt eine Umgebungsvariable, nicht deren Wert. Ohne ausdrückliche Token-Quelle verwendet context set VIBELETTER_TOKEN, sofern gesetzt. Ansonsten bleibt ein vorhandenes Token nur bei unveränderter Instanz erhalten. --clear-token entfernt es. Token-Dateien müssen dem aktuellen Nutzer gehören und dürfen keine Gruppen- oder Fremdrechte haben. Datei/stdin dürfen genau ein abschließendes LF oder CRLF enthalten; andere Leerzeichen werden nicht entfernt.

Instanz-Priorität: --instance oder --context, danach VIBELETTER_INSTANCE, danach ausgewählter Kontext, danach lokale/globale Defaults, schließlich http://localhost:3035. --instance und --context zusammen sind ein Fehler. Token-Priorität: VIBELETTER_TOKEN, danach Token des ausgewählten Kontextes, danach passender Konfigurations-Default. Ein gespeichertes Token wird niemals auf eine andere Instanz übertragen. URLs enthalten keine Zugangsdaten, Query oder Fragmente. HTTPS ist Pflicht außerhalb von Loopback. Der HTTP-Client folgt keinen Redirects. Kontextnamen sind 1 bis 64 Buchstaben, Ziffern, Unterstriche oder Bindestriche. Lokale Kontexte gleichen Namens haben Vorrang; --scope bei Kontext-Leseoperationen und verify wählt eine konkrete Datei. health erfordert ein gültiges Token mit health:read, context verify zusätzlich overview:read.

JSON-Format der Konfiguration:

\`\`\`json
{
  "version": 1,
  "currentContext": "production",
  "contexts": {
    "production": { "instance": "https://letters.example.com" }
  }
}
\`\`\`

readiness liest die öffentliche /api/v1/health ohne Token und sendet keinen Authorization-Header, auch wenn ein Token konfiguriert ist. health und context verify bleiben authentifiziert und verwenden /api/v1/health/details. Öffentliche Readiness prüft keine Berechtigungen und ersetzt keine Kontext-Verifikation.

Gespeicherte Zugangsdaten stehen optional als token im jeweiligen Kontext. Leseoperationen zeigen nur [REDACTED], niemals Teile des Tokens. instance und token auf oberster Ebene sind optionale Konfigurations-Defaults. Schlüssel-Erstellung ist die einzige API-Operation, deren Antwort ein neues Klartext-Token enthalten darf. keys create --out prüft Zieltyp, Symlinks und die Schreibbarkeit des Verzeichnisses vor dem POST. Die Antwort wird mit Modus 0600 gespeichert, stdout enthält nur Pfad und Byteanzahl. Scheitert das Speichern trotzdem, versucht die CLI genau einmal, ausschließlich die ID aus dieser erfolgreichen Erstellungsantwort zu widerrufen, und prüft sie per GET nach. key_output_failed nennt keyId und revoked, nie das Klartext-Token. Bei revoked:false ist der Widerruf nicht bestätigt. Prüfe keys get <keyId> auf derselben Instanz und widerrufe den Schlüssel manuell. Fehlt eine eindeutig gültige neue ID, erfolgt kein automatischer Widerruf. Die Erstellung wird nie automatisch wiederholt. Die CLI erweitert keine Scopes eines vorhandenen Schlüssels. Der Server prüft angeforderte Scopes gegen den authentifizierten Actor.

## JSON, HTML und Markdown

Schreibbefehle akzeptieren --file für ein JSON-Objekt. - liest stdin. Benannte Feldoptionen überschreiben gleichnamige Dateifelder. Nicht gelistete originale und verschachtelte Einstellungen bleiben über JSON möglich. Dateigröße/stdin sind begrenzt. Jeder Aufruf kann stdin nur einmal lesen.

Newsletter-Felder heißen name, slug, fromName, fromEmail, replyTo und postalAddress. Kontakt- und Kampagnenerstellung verwenden newsletter als Slug, nicht newsletterId. IDs für Newsletter, Kontakte, Kampagnen, Schlüssel und Sperren bestehen aus genau 24 Hex-Zeichen; ihre Schreibweise bleibt erhalten. Queue-IDs sind positive Dezimalzahlen ohne führende Nullen. Domain-Kennungen sind Domainnamen.

\`\`\`sh
vibeletter newsletters create --name Updates --slug updates --from-name Team --from-email updates@example.com --postal-address "Example Street 1"
vibeletter newsletters update <id> --file newsletter-settings.json
vibeletter contacts create --newsletter updates --email reader@example.com --source website
vibeletter campaigns create --newsletter updates --subject "October update" --preview-text "The latest changes" --markdown-file issue.md
vibeletter campaigns update <id> --html-file issue.html
vibeletter campaigns create --file - < campaign.json
vibeletter campaigns preview <id> --out preview.html
vibeletter campaigns report <id> --out report.json
\`\`\`

Nicht leere html- und markdown-Inhalte schließen einander aus. campaigns create braucht nur den Newsletter-Slug und kann einen leeren Entwurf anlegen. Inhalte kommen aus JSON oder --html-file/--markdown-file. Originale Feldnamen werden weder in einen anderen Newsletter-Namen noch in neue Kampagnenfelder umbenannt.

campaigns list erhält neben items, total, limit und offset auch issues, issuesTotal, issuesLimit und issuesOffset samt öffentlichen URLs. Veröffentlichte issues bilden eine eigene Sammlung und folgen nicht dem Statusfilter der Operator-Liste. Ohne --all bleiben beide Sammlungen paginiert. --all liest beide vollständig ab Offset 0, auch wenn eine Sammlung mehr Seiten hat oder items leer ist. Jede Sammlung wird auf stabile Gesamtzahl, erwartete Offsets und eindeutige IDs geprüft. Bei Änderungen oder fehlenden Seiten bricht die CLI ab, statt eine erste Issue-Seite als vollständig auszugeben. limit und issuesLimit nennen weiterhin die verwendete Seitengröße.

campaigns report erhält alle vom Server gelieferten JSON-Felder unverändert, einschließlich providers und events. providers zählt tatsächlich versandte Kampagnennachrichten je Provider, keine Willkommens-, Bestätigungs- oder Testnachrichten. messages und events sind eigenständige paginierte Sammlungen mit items, total, limit und offset. --limit und --offset gelten für beide Sammlungen, nicht für eine kombinierte Gesamtzahl. Der Bericht besitzt kein --all; die angezeigte Nachrichten- oder Ereignisseite behauptet keine vollständige Sammlung.

## Kontakte importieren und exportieren

\`\`\`sh
vibeletter contacts import --newsletter updates --file contacts.csv --batch-size 1000 --json
vibeletter contacts import --format json --file import.json --json
vibeletter contacts import --newsletter updates --file - < contacts.csv
vibeletter contacts export --newsletter updates --out contacts.csv --json
vibeletter contacts export --newsletter updates --format json --out contacts.json
vibeletter contacts export --newsletter updates --raw-csv --out reimport.csv
vibeletter contacts status <id> unsubscribed
\`\`\`

CSV unterstützt Kommas, CRLF/LF, UTF-8-BOM, Anführungszeichen und eingebettete Zeilenumbrüche. email ist erforderlich. status fehlt bedeutet active; zulässig sind active, dormant, unsubscribed, bounced, complained. Optionale Importfelder: subscribedAt, emailsReceived, openRate, clickRate. Raten sind 0 bis 1 oder Prozentwerte wie 25%. Mehrere verbreitete email/status-Spaltennamen werden erkannt. Ungültiges CSV wird vor der ersten HTTP-Anfrage abgewiesen. JSON-Import erwartet {"newsletter":"updates","rows":[{"email":"reader@example.com","status":"active"}]}; source ist optional.

Importe laufen sequentiell in Batches mit maximal 1000 Zeilen. Die Serverregeln verhindern das Reaktivieren durch Import. Ein fehlgeschlagener Batch beendet den Aufruf mit Fehler, completedBatches, rowsSubmitted und den tatsächlichen Antworten bisheriger Batches. Es gibt keine automatische Wiederholung und keine Rücknahme bereits erfolgreicher Batches.

Export liest alle REST-Listenseiten, prüft total, offset und eindeutige IDs, bevor eine Datei ersetzt wird. Verändert sich total, bricht der Export ab. CSV enthält _id, newsletterId, email, status, source, subscribedAt, unsubscribedAt, emailsReceived, openRate und clickRate. Importierte Kennzahlen werden aus imported gelesen. subscribedAt muss einen ISO-8601-Zeitpunkt mit Sekunden und Zeitzone enthalten. JSON exportiert die vollständigen API-Datensätze samt Listen-Metadaten. CSV-Import ignoriert System- und Metadatenspalten wie _id, newsletterId, source und unsubscribedAt. Die Import-Herkunft wird für alle Zeilen über --source gesetzt. JSON-Import erlaubt nur die genannten Importfelder und prüft alle Zeilen vor dem ersten Request. CSV schützt standardmäßig vor Tabellenkalkulationsformeln. --raw-csv erhält Werte für maschinellen Reimport, gehört aber nicht in eine ungeschützte Tabellenkalkulation. Neue Datenbank-IDs werden beim Import serverseitig bestimmt. pending ist kein CSV-Importstatus. Import ist keine Wiederherstellung von Systemfeldern und löst keine Willkommensmail aus.

Ohne --out schreibt Export stdout. --out - wählt stdout ausdrücklich. --json und CSV auf stdout sind inkompatibel. Mit --out enthält JSON nur Pfad, total und Byteanzahl; die CSV liegt in der privaten Datei.

## Versand und globale Sperren

send, test, schedule, resume, send-more und newsletters welcome-test können Mail auslösen, wenn der Server Versand aktiviert hat. Ohne SENDING_ENABLED meldet der echte Server einen Fehler, keine simulierte erfolgreiche Zustellung. Prüfe Instanz, Newsletter und Zielgruppe vor dem Aufruf. cleanup-preview und preview senden nicht. schedule --at verlangt Sekunden und eine explizite Zeitzone. pin --value setzt einen booleschen Wert statt eines unbemerkten Umschaltens. newsletters delete, contacts delete und campaigns delete benötigen --confirm; campaigns delete verwirft den Entwurf statt ihn physisch zu löschen. Entfernen einer globalen Sperre benötigt suppressions remove <id> --confirm und ändert nicht selbst den geschützten Kontaktstatus.

\`\`\`sh
vibeletter campaigns cleanup-preview <id> --json
vibeletter campaigns schedule <id> --at 2027-01-15T10:00:00+01:00 --audience-limit 50
vibeletter campaigns pin <id> --value true
vibeletter keys create --name contacts-reader --scopes contacts:read --out created-key.json
vibeletter suppressions add --email blocked@example.com --reason manual
vibeletter suppressions remove <id> --confirm
vibeletter domains account --json
vibeletter uploads create image.png
\`\`\`

Uploads senden unveränderte Bildbytes mit passendem Content-Type und X-File-Name, kein multipart/form-data. Dateinamen im Header werden URI-kodiert. PNG, JPEG, GIF und WebP sind zulässig, bis 4 MiB. Der Server prüft tatsächliche Bildbytes und seine Storage-Konfiguration; ein MIME-Label allein macht keine Datei gültig. stdin braucht --name und gegebenenfalls --mime.

## Fehler und Ausgaben

Normale Antworten sind eingerücktes JSON, --json macht sie kompakt. JSON-Fehler stehen auf stderr als {"error":{"code":"…","message":"…","status":400,"details":{}}}; status und details fehlen, wenn nicht vorhanden. Fehler haben einen Exitcode ungleich 0, Hilfe und Version Exitcode 0. Tokens werden auch aus Fehlermeldungen entfernt. --timeout begrenzt Verbindung und Antwortkörper. Nicht-JSON, unvollständige Listen und {error:…}/{ok:false} in einer 2xx-Antwort gelten nicht als Erfolg. Leere 204-Antworten werden als null ausgegeben.

Schreiboperationen werden nie automatisch wiederholt. Bei Verbindungs-/Timeoutfehler nach einem Schreibaufruf lautet der Code outcome_unknown. Lies den Ziel-Datensatz oder die Queue, bevor du selbst erneut sendest. Ein HTTP-Erfolg allein bedeutet nicht, dass eine Mail beim Empfänger angekommen ist.

queue retry wird mit HTTP 409 verweigert, wenn die Zustellung unklar ist oder der Provider die Nachricht bereits akzeptiert hatte. Auch ein späterer Providerfehler erlaubt keinen blinden Neuversand. Prüfe Auftrag, Providerstatus und Ereignisse, statt dieselbe Anfrage zu wiederholen. Die CLI übernimmt den Serverfehler und wiederholt den Schreibaufruf nicht.

catalog --json enthält den lokalen Befehlsvertrag mit Argumenten, Optionen und HTTP-Zuordnung, keine Behauptung über die aktuelle Provider-Verfügbarkeit. Authentifizierung, Scopes und Versandregeln bleiben beim Server. DB-Migration und Operator-Provisionierung sind lokale Web-Workspace-Kommandos, kein versteckter Remote-CLI-Pfad.

## Dokumentation aktualisieren

\`\`\`sh
npm run build --workspace @vibelabsdotto/vibeletter-cli
npm run docs --workspace @vibelabsdotto/vibeletter-cli
npm run docs:check --workspace @vibelabsdotto/vibeletter-cli
\`\`\`

`;

let help = '## Vollständige Befehlsreferenz\n\n';
for (const { parts } of entries) {
  const label = ['vibeletter', ...parts].join(' ');
  const result = spawnSync(process.execPath, [bin, ...parts, '--help'], { encoding: 'utf8', env: process.env });
  if (result.status !== 0 || result.error) throw new Error(`--help fehlgeschlagen: ${label}: ${result.stderr}`);
  help += `### ${label}\n\n\`\`\`text\n${result.stdout.trimEnd()}\n\`\`\`\n\n`;
}
const http = '## HTTP-Zuordnung\n\n| Befehl | Methode | Pfad | Body/Verhalten |\n| --- | --- | --- | --- |\n' + catalog.commands.filter((item) => item.http).map((item) => {
  const operation = item.http;
  return `| \`${item.command}\` | ${operation.method} | \`${operation.path}\` | ${operation.action ? `action=${operation.action}. ` : ''}${operation.note ?? ''} |`;
}).join('\n') + '\n';
const short = '# VibeLetter CLI\n\n> Context-aware operator client. Node.js >=24, executable vibeletter, package @vibelabsdotto/vibeletter-cli.\n\n- Full guide: llms-full.txt\n- Machine-readable discovery: vibeletter catalog --json\n- Contexts: ~/.config/vibeletter/config.json and .vibeletter/config.json\n- Token input: env, private file, stdin. No token argv.\n- API: /api/v1, bearer auth, real errors, no automatic write retries.\n\n' + entries.filter((entry) => entry.parts.length && !entry.command.commands.length).map((entry) => `- ${['vibeletter', ...entry.parts].join(' ')}: ${entry.command.description()}`).join('\n') + '\n';
const outputs = [
  [path.join(repo, 'docs/CLI.md'), intro + http + '\n' + help],
  [path.join(cli, 'llms.txt'), short],
  [path.join(cli, 'llms-full.txt'), intro + http + '\n' + help],
];
for (const [file, content] of outputs) {
  const text = content.trimEnd() + '\n';
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) throw new Error(`Generierte Dokumentation ist veraltet: ${path.relative(repo, file)}`);
  } else fs.writeFileSync(file, text);
}
console.log(`${process.argv.includes('--check') ? 'Geprüft' : 'Geschrieben'}: ${outputs.length} Dokumente, ${entries.length} ausgeführte --help-Aufrufe.`);
