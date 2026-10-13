# VibeLetter auf einem eigenen Host betreiben

Der unterstützte Betrieb nutzt einen Host, eine Webinstanz und genau einen Worker. Beide greifen auf dieselben lokalen SQLite-Dateien zu. Ein Reverse Proxy stellt HTTPS bereit. R2 speichert Bilder, SES versendet Nachrichten und SNS liefert Feedback an die App.

Nicht geeignet sind Serverless-Instanzen, mehrere Hosts mit derselben Datenbank, NFS/SMB-Volumes und horizontale Replikation. SQLite-WAL braucht zuverlässige lokale Dateisperren. Ein Load Balancer macht daraus keine verteilte Datenbank.

## Dateien und Grenzen

- `Dockerfile` baut mit Node.js 24 LTS. Der Builder installiert auch Entwicklungsabhängigkeiten. Der Laufzeitcontainer nutzt Produktionsabhängigkeiten einschließlich nicht-hoistbarer Workspace-Abhängigkeiten und enthält Webserver, Workerquellen, Migrationen, Fonts und CLI. Der Imagebau öffnet die native SQLite-Laufzeit und führt die CLI-Hilfe aus, damit fehlende Runtime-Abhängigkeiten den Build abbrechen.
- `.dockerignore` hält lokale Env-Dateien, Datenbanken, Buildverzeichnisse und Agent-Artefakte aus dem Build-Kontext.
- `docker-compose.yaml` definiert `migrate`, `web` und `worker` mit demselben benannten Volume `vibeletter_data`.
- `deploy/production.env.example` ist eine Vorlage ohne Zugangsdaten.
- `deploy/Caddyfile.example` ist ein Beispiel für einen auf dem Host installierten HTTPS-Proxy. Compose startet keinen Proxy und verwaltet kein DNS.

Der Container läuft als Nutzer `node`. Ein neu angelegtes benanntes Volume übernimmt die vorbereiteten Eigentumsrechte des `/app/data`-Verzeichnisses. Bei einem vorhandenen Volume oder einem Bind-Mount musst du dessen Rechte gezielt prüfen. Das Image ändert nicht beim Start rekursiv die Eigentümer deiner Daten.

## Erstinstallation

### Produktionsumgebung konfigurieren

```bash
cp deploy/production.env.example .env.production
chmod 600 .env.production
```

Setze mindestens `APP_URL`, `BETTER_AUTH_URL`, `ADMIN_EMAIL`, `BETTER_AUTH_SECRET` und `SESSION_SECRET`. Beide URLs müssen denselben öffentlichen HTTPS-Ursprung ohne Pfad verwenden. Erzeuge die beiden unterschiedlichen Secrets separat mit `openssl rand -base64 48`.

Trage R2-Zugangsdaten für den ausgewählten Bucket und SES-Einstellungen ein. Halte `SENDING_ENABLED=false`. Der Host-AWS-Ordner wird nicht automatisch in Container eingebunden. Nutze gezielt eine verfügbare Credential-Chain, einen geeigneten Host-/Workload-Rollenmechanismus oder ein eng berechtigtes SES-Schlüsselpaar. Temporäre SES-Zugangsdaten brauchen auch `SES_SESSION_TOKEN`.

Compose liest `.env.production` als Container-Env-Datei. Es erzwingt `NODE_ENV=production`, `DEV_LOGIN_ENABLED=false` und die Datenbankpfade auf dem gemeinsam gemounteten Volume. Das verhindert, dass eine Entwicklungsdatei den Container-Login freischaltet. Es gibt keinen Produktions-Bypass.

Die Env-Datei ist kein Docker-Secret. Nutzer mit Zugriff auf den Docker-Daemon können Containerumgebungsvariablen und Daten lesen. Beschränke diesen Zugriff. Veröffentliche weder `docker compose config` mit aufgelösten Werten noch Debugausgaben deiner Credentials.

### Image bauen und Prozesse starten

```bash
docker compose build
docker compose up -d
docker compose ps -a
docker compose logs --tail 100 migrate web worker
```

`migrate` muss mit Exitcode 0 enden. Erst dann startet Compose die beiden anderen Dienste. Dieser Befehl führt zuerst die committed Drizzle-Migrationen einschließlich der Better-Auth-Tabellen aus, danach die offizielle `migrateDB()`-Migration von liteque für die separate Queue-Datei. Beide Schritte sind erforderlich und dürfen erneut ausgeführt werden. Webstart und Operator-Provisionierung sind keine Ersatzmigrationen.

Die Web-Healthcheck ruft `/login` über HTTP im Container ab. "healthy" bedeutet, dass diese HTTP-Prüfung erfolgreich war. Sie prüft nicht die SES-Zustellung, das SNS-Abonnement, R2 oder einen arbeitsfähigen Worker. Der Worker hat keine vorgetäuschte HTTP-Healthcheck.

### HTTPS bereitstellen

1. Richte DNS für die endgültige App-Domain auf den Host ein.
2. Verwende einen HTTPS-Reverse-Proxy. Das Caddy-Beispiel leitet auf `127.0.0.1:3035` weiter.
3. Erhalte den ursprünglichen `Host`-Header. Veröffentliche Port 3035 nicht zusätzlich direkt.
4. Rufe `https://<app-domain>/login` auf und prüfe Zertifikat, Redirects und Login.
5. Halte `/api/webhooks/ses` für AWS SNS öffentlich erreichbar. Eine vorgeschaltete Basic-Auth oder Bot-Challenge darf diesen Endpunkt nicht blockieren. Dashboard und Operator-API bleiben durch die App geschützt.

`APP_URL` steckt in Empfängerlinks. Eine später geänderte Domain ersetzt keine Links in bereits versendeten Mails. Erhalte die alten URLs, wenn solche Mails noch genutzt werden.

### Operator provisionieren

Das Produkt hat keinen öffentlichen Signup. Lege das Passwort einmal explizit für `ADMIN_EMAIL` an. Die folgende Variante ist für Bash und leitet das verdeckt eingegebene Passwort an den Provisionierungsbefehl weiter. Das Passwort steht nicht im Kommandoargument oder in der Containerkonfiguration.

```bash
set -o pipefail
IFS= read -r -s -p 'Operator-Passwort: ' operator_password
printf '\n'
printf '%s' "$operator_password" | docker compose run --rm --no-deps -T migrate provision --password-stdin
unset operator_password
```

Das Passwort muss 12 bis 128 Zeichen haben. Ein bereits vorhandenes Passwortkonto führt zu einem Fehler statt zu einem stillen Reset. Nach erfolgreicher Provisionierung meldest du dich über die HTTPS-Loginseite an. Prüfe auch, dass falsche Credentials scheitern und ein anonymer Request keine Operator-Daten lesen kann.

## Abnahme vor echtem Versand

- Migrationen mit Exitcode 0 abgeschlossen, nur eine Webinstanz und ein Worker aktiv.
- `APP_URL` und `BETTER_AUTH_URL` stimmen überein, HTTPS funktioniert, Entwicklungslogin ist gesperrt.
- Operatorlogin und ein absichtlich abgewiesener anonymer Operator-Request geprüft.
- Newsletter-Absender, Reply-To und reale Postanschrift korrekt.
- Jede verwendete SES-Domain in der richtigen Region verified, DKIM aktiv und MAIL FROM überprüft.
- IAM erlaubt die verwendeten Identitäten, nicht beliebige Domains.
- SNS-Topic und SES-Konfigurationsset richtig verbunden, HTTPS-Abonnement bestätigt, Signaturprüfung und dauerhafte Verarbeitung mit Simulatorereignissen geprüft.
- Bild-Upload und öffentlicher Abruf eines freigegebenen Testbilds funktionieren mit dem gewählten R2-Bucket.
- Queue und tatsächlicher Workerzustand geprüft, keine unerwarteten alten Aufträge aus einer früheren Instanz.

Erst dann setzt du `SENDING_ENABLED=true` in `.env.production` und erstellst Web und Worker neu:

```bash
docker compose up -d --no-deps --force-recreate web worker
```

Damit wird realer Versand freigegeben, auch für Willkommens-, Bestätigungs-, Test- und Alarmmails. Ein bloßer `restart` lädt veränderte Env-Dateien nicht in bestehende Container. Prüfe die Empfänger vor der Aktivierung. Die [SES-Anleitung](SES-DOMAINS.md) beschreibt Simulatoren und Feedbackabnahme.

## CLI für den Betrieb

Baue die CLI im Repository oder nutze die bereits im Image vorhandene Version:

```bash
node apps/cli/dist/index.js --help
docker compose run --rm --no-deps migrate cli --help
```

Für einen regelmäßigen Operatorarbeitsplatz ist ein eigener CLI-Kontext praktischer als ein kurzlebiger Container. Erzeuge einen API-Key mit den nötigen Scopes, begrenze Ablauf und Zugriff und speichere den Token mit privaten Dateirechten. Keine Tokenwerte als Kommandoargumente verwenden.

Erzeuge diesen Schlüssel nach regulärem Login in der Produktionsinstanz. Entwicklungs- und unbekannte Alt-Schlüssel werden dort abgewiesen, selbst wenn dieselbe Datenbank weiterverwendet wird. Ein anderer CLI-Kontext, Schlüsselname oder Ablauf macht daraus keinen Produktionsschlüssel. Die Migration markiert unbekannte Alt-Ausgaben bewusst als nicht produktionsberechtigt; stelle sie über den regulären Produktionslogin neu aus.

```bash
node apps/cli/dist/index.js context set production --instance https://letter.example.com --token-stdin < /private/path/operator.token
node apps/cli/dist/index.js --context production health --json
node apps/cli/dist/index.js --context production queue list --json
```

Prüfe vor jeder Schreibaktion den gewählten Kontext. Die genaue Befehlsreferenz und sichere Tokenquellen stehen in [CLI.md](CLI.md).

## Aktualisieren und Migrationen anwenden

Prüfe den neuen Quellstand und die generierten SQL-Migrationen vor dem Update. Arbeite in einem Wartungsfenster. Diese Anleitung erstellt keine automatische Sicherung. Plane gesondert, wie du Daten nach einem fehlgeschlagenen Update wiederherstellst, und führe Sicherungen nur nach deiner expliziten Betriebsfreigabe aus.

```bash
# Vor dem Wartungsfenster bauen. Noch laufende Container behalten ihr altes Image.
docker compose build
# Beide schreibenden Prozesse stoppen, bevor das Schema geändert wird.
docker compose stop worker web
# Explizite Migration aus dem neuen Image.
docker compose run --rm --no-deps migrate
# Nur nach erfolgreicher Migration starten.
docker compose up -d --no-deps --force-recreate web worker
docker compose ps -a
```

Bei einem Migrationsfehler bleibt der Versand gestoppt. Ein altes Image ist kein automatischer Schema-Rollback. Drizzle-Migrationen werden nicht durch `db:generate` rückgängig gemacht. Starte einen alten Stand nur, wenn seine Kompatibilität mit dem aktuellen Schema geprüft ist.

Bestätigungsnachrichten speichern ihre Consent-Generation. Alte Queue-Nachrichten ohne diese Bindung dürfen nicht nachträglich den aktuellen Bestätigungslink verwenden. Neue Nachrichten benötigen eine aktuell gültige Anmeldung. Ungebundene alte Nachrichten mit unklarem oder bereits angenommenem Versand blockieren weitere Bestätigungen, bis ihr Ausgang geklärt ist. Es gibt keine automatische Zuordnung über Zeitstempel.

Bewahre die SES-Eventdatensätze auf. Ihre IDs verhindern, dass SNS-Wiederholungen Kontakte, Sperren oder Statistiken erneut ändern. Der alte Stand hat für einige Ereignistypen keine Datensätze gespeichert; deren frühere Verarbeitung lässt sich nicht nachträglich rekonstruieren. Nach dem ersten Eingang im neuen Stand werden auch diese Wiederholungen erkannt.

Nutze `npm run db:generate` ausschließlich für beabsichtigte Schemaänderungen in der Entwicklung. Generiere keine spontanen Migrationsdateien auf dem Produktionshost und verwende kein `drizzle-kit push`.

## Daten erhalten und wiederherstellen

`docker compose down` entfernt Container und Netzwerk, nicht das benannte Volume. `docker compose down -v` löscht das Datenvolume. Das löscht unter anderem Kontakte, Kampagnen, Authdaten und Queue. Verwende diesen Befehl nicht als Neustart oder Fehlerbehebung.

Eine ausdrücklich geplante Sicherung muss Anwendungsdatenbank und Queue als konsistenten Stand behandeln. WAL- und SHM-Dateien gehören zum SQLite-Betrieb. Eine unkoordinierte Dateikopie während des Schreibens ist keine verlässliche Sicherung. R2-Objekte und die geschützte Konfiguration sind separate Wiederherstellungskomponenten.

Eine alte Queue wiederherzustellen kann Aufträge enthalten, die SES inzwischen angenommen hat. Gleiche Nachrichtenstatus und SES-Ereignisse ab, bevor du den Worker startest. Eine Wiederherstellung erzeugt keine Exactly-once-Garantie. Halte `SESSION_SECRET` stabil, damit bereits versendete Empfängerlinks weiter gültig bleiben.

## Störungen behandeln

### Versand stoppen

```bash
docker compose stop worker
```

Das stoppt den lokalen Consumer. Ein bereits an SES übergebener Request lässt sich dadurch nicht zurückrufen. Für einen längeren Versandstopp setze zusätzlich `SENDING_ENABLED=false` und erstelle beide Dienste neu. Sichere die Ursache, bevor du alte Aufträge fortsetzt.

### Keine Zustellereignisse

Prüfe SES-Konfigurationsset, Topic-ARN, Topic-Policy, bestätigtes HTTPS-Abonnement und Webhookantworten. Ein SES-Message-ID oder ein grüner Webcontainer beweist keinen Feedbackfluss. Fehlende Feedbackdaten sind kein Beweis, dass keine Mail gesendet wurde.

### Unsicherer Versandstatus

Verbindungstimeout oder Workerabbruch kann nach SES-Annahme passieren. Starte keine blinde Wiederholung und lege keine zweite Sendung derselben Kampagne an. Prüfe Queueeintrag, Nachrichtendatensatz und verfügbares SES-Feedback. Wenn der Ausgang nicht geklärt werden kann, muss ein Operator bewusst entscheiden.

### Datenbank gesperrt oder Worker startet mehrfach

Prüfe freien Speicher, Dateirechte, Volume-Mounts, Pfade und Prozessanzahl. Beende keine fremden Prozesse und lösche keine WAL-Dateien auf Verdacht. Skaliere den Worker nicht hoch, um ein Lockproblem zu umgehen.

### Auth- oder Empfängerlink-Schlüssel ändern

`BETTER_AUTH_SECRET` betrifft Authentifizierung. `SESSION_SECRET` signiert Empfängerlinks und ist davon getrennt. Eine Rotation des Linkschlüssels macht alte Bestätigungs-, Abmelde- und Trackinglinks ungültig. Plane eine solche Änderung ausdrücklich, statt sie bei jedem Deployment neu zu generieren.

## Laufzeit ohne Docker

Der gleiche Ein-Host-Aufbau ist mit einem Prozessmanager möglich. Installiere zuerst mit `npm ci`, baue beide Workspaces und stelle die Umgebung für beide Prozesse explizit bereit. Wende danach `npm run db:migrate` und `npm run queue:migrate` an. Starte separat `npm run start --workspace apps/web` und `npm run worker` mit `NODE_ENV=production`.

Worker und Migrationen brauchen `tsx` zur Laufzeit. Wenn du Produktionsabhängigkeiten separat installierst, müssen auch diese Runtime-Werkzeuge und alle committed Migrationsdateien vorhanden sein. Native `better-sqlite3`-Binaries müssen zum Betriebssystem und zur Node-Version passen. Kopiere keine macOS-`node_modules` auf einen Linuxhost.

## Referenzen

- [Docker Compose und Startreihenfolge](https://docs.docker.com/compose/how-tos/startup-order/)
- [Next.js standalone und Dateitracing](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
- [SES-Domains und Feedback](SES-DOMAINS.md)
- [Sicherheitsgrenzen](../SECURITY.md)
