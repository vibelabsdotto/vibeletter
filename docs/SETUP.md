# VibeLetter einrichten

Diese Anleitung startet eine lokale Entwicklungsinstanz ohne Mailversand. Für den Betrieb mit echten Kontakten nutze [Deployment](DEPLOYMENT.md) und [SES-Domains](SES-DOMAINS.md).

## Voraussetzungen

- Node.js 24 LTS und npm.
- Ein lokales Dateisystem für SQLite. Web und Worker müssen dieselben Datenbankdateien verwenden.
- Für Bilder im Produktivbetrieb ein R2-Bucket mit passenden Objektberechtigungen.
- Für echten Versand ein SES-Konto mit überprüfter Identität und funktionierendem Feedback.

Es gibt keine MongoDB-, Redis-, Upstash- oder Vercel-Einrichtung. Ein Versand-Worker ist trotzdem erforderlich. Das Webfrontend allein verarbeitet keine geplanten Sendungen.

## Lokale Umgebung vorbereiten

Führe die Befehle im Repository-Stamm aus:

```bash
npm ci
cp .env.example .env
chmod 600 .env
```

Erzeuge zwei voneinander unabhängige Werte:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

Trage einen Wert als `BETTER_AUTH_SECRET` und den anderen als `SESSION_SECRET` in `.env` ein. Beide müssen mindestens 32 Zeichen lang sein. Sie dürfen nicht identisch sein. Verwende lokal:

```dotenv
APP_URL=http://localhost:3035
BETTER_AUTH_URL=http://localhost:3035
ADMIN_EMAIL=dev@localhost.test
DEV_LOGIN_ENABLED=true
SENDING_ENABLED=false
```

Nutze für `DATABASE_PATH` und `QUEUE_DATABASE_PATH` absolute Pfade in einem lokalen Verzeichnis, beispielsweise `/home/operator/vibeletter-data/vibeletter.db` und `/home/operator/vibeletter-data/queue.db`. Lass gesetzte Pfadvariablen nicht leer. Die Beispiele sind keine Pfade auf deinem Rechner. Erstelle das ausgewählte Verzeichnis und beschränke seinen Zugriff auf den Operator. Unterschiedliche Pfade zwischen Web und Worker führen zu getrennten Instanzen oder einer nicht abgearbeiteten Queue.

Für die folgenden Befehle muss `.env` eine vertrauenswürdige, shell-kompatible Datei sein. Werte mit Leerzeichen müssen in Anführungszeichen stehen. `source` beziehungsweise `.` führt Shellcode aus, also keine fremde Datei damit laden. Exportiere dieselbe Umgebung in jedem Terminal:

```bash
set -a
. ./.env
set +a
```

Next.js lädt eigene Env-Dateien aus `apps/web`. Eine dortige `.env.local` wird nicht automatisch an einen separat gestarteten Worker weitergegeben. Das explizite Exportieren verhindert diese Abweichung. Eine Änderung in einer Env-Datei wirkt erst nach dem Neustart der betroffenen Prozesse.

## Migrationen und Web starten

```bash
NODE_ENV=development npm run db:migrate
NODE_ENV=development npm run queue:migrate
npm run dev:web
```

Öffne `http://localhost:3035`. Der lokale Entwicklungslogin setzt `NODE_ENV=development`, `DEV_LOGIN_ENABLED=true`, eine Loopback-`APP_URL` und einen passenden tatsächlichen Request-Host voraus. Ein Proxyheader darf diese Prüfung nicht freischalten. In Produktion ist dieser Zugang immer gesperrt.

Starte in einem zweiten Terminal mit derselben exportierten Umgebung:

```bash
NODE_ENV=development npm run worker
```

`SENDING_ENABLED=false` verhindert echten SES-Versand. Es ist kein Mock-Erfolg und kein Beleg für eine Zustellung. Ein lokaler Worker braucht keine öffentlich erreichbaren Job-Callbacks.

## Regulären Operator anlegen

Die Anwendung hat genau einen Operator. `ADMIN_EMAIL` legt dessen E-Mail-Adresse fest. Ein neuer Nutzer kann sich in Produktion nicht selbst registrieren. Das Passwort steht nicht als `ADMIN_PASSWORD` in der Konfiguration.

Nach den Migrationen nimmt der lokale Provisionierungsbefehl ein Passwort mit 12 bis 128 Zeichen über `VIBELETTER_OPERATOR_PASSWORD` oder `--password-stdin` entgegen. Gib kein Passwort als Kommandoargument an. Ein bestehendes Passwortkonto wird nicht stillschweigend überschrieben.

Beispiel für Bash mit verdeckter Eingabe:

```bash
IFS= read -r -s -p 'Operator-Passwort: ' VIBELETTER_OPERATOR_PASSWORD
printf '\n'
export VIBELETTER_OPERATOR_PASSWORD
NODE_ENV=development npm exec --workspace apps/web -- tsx --conditions=react-server src/scripts/provision-operator.ts
unset VIBELETTER_OPERATOR_PASSWORD
```

Die Variablenmethode ist für diesen lokalen Einmalbefehl gedacht. Speichere das Passwort nicht dauerhaft in `.env`, Logs oder Shellhistorie. Die [Docker-Anleitung](DEPLOYMENT.md#operator-provisionieren) nutzt stdin, damit Compose das Passwort nicht als Containerumgebungsvariable speichern muss.

## R2 für Bilder konfigurieren

1. Erstelle einen Bucket im passenden Cloudflare-Konto. Die App verwendet den normalen Endpoint `https://<account-id>.r2.cloudflarestorage.com`. Wähle keinen Bucket mit einem speziellen Jurisdiction-Endpoint, solange der Adapter diesen nicht unterstützt.
2. Erzeuge einen R2-S3-API-Token mit "Object Read & Write", beschränkt auf diesen Bucket. Ein normaler Cloudflare-Bearer-API-Token ist kein S3-Schlüsselpaar.
3. Trage `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` und `R2_SECRET_ACCESS_KEY` ein. Setze `UPLOAD_STORAGE=r2`.
4. Lass `R2_PUBLIC_URL` leer, wenn der Bucket privat bleiben soll. Die Anwendung liefert validierte Bilder dann über `/api/files/...` aus.
5. Wenn du `R2_PUBLIC_URL` verwendest, muss die HTTPS-Basis-URL die Objekte wirklich ausliefern. Das Setzen der Variable veröffentlicht weder den Bucket noch eine Domain.
6. Lade ein freigegebenes Testbild im Editor hoch und rufe die zurückgegebene URL ohne Operator-Session ab.

Der Upload akzeptiert PNG, JPEG, GIF und WebP bis 4 MiB und prüft die Dateistruktur. SVG und beliebige Dokumente sind keine unterstützten Uploads. Die App liest das gespeicherte Objekt nach dem Schreiben zurück. Der öffentliche Bildabruf ist notwendig, damit E-Mail-Clients Bilder laden können. Nutze ihn nicht für vertrauliche Anhänge.

Für reine Entwicklung kannst du explizit `UPLOAD_STORAGE=local` und `UPLOAD_LOCAL_DIR` auf ein lokales Verzeichnis setzen. Das funktioniert nur mit `NODE_ENV=development`. Es gibt keinen Produktions-Fallback von R2 auf lokale Dateien.

Cloudflare-Referenz: [R2-S3-Authentifizierung und Tokenberechtigungen](https://developers.cloudflare.com/r2/api/s3/tokens/).

## Konfiguration nachschlagen

| Variable | Verwendung |
| --- | --- |
| `APP_URL` | Kanonischer Ursprung für Dashboard und Empfängerlinks, ohne Pfad, Query oder Zugangsdaten. In Produktion HTTPS. |
| `BETTER_AUTH_URL` | Derselbe Ursprung wie `APP_URL`. |
| `ADMIN_EMAIL` | E-Mail-Adresse des explizit angelegten Operators. |
| `BETTER_AUTH_SECRET` | Separater Auth-Schlüssel mit mindestens 32 Zeichen. |
| `SESSION_SECRET` | Separater Empfängerlink-Schlüssel mit mindestens 32 Zeichen. Nach dem ersten Versand stabil halten. |
| `DEV_LOGIN_ENABLED` | Nur Entwicklung, explizit `true` und nur Loopback. In Produktion `false`. |
| `DATABASE_PATH` | SQLite-Anwendungsdatenbank, absoluter lokaler Pfad empfohlen. |
| `QUEUE_DATABASE_PATH` | Persistente SQLite-Queue, gleicher Pfad für Web und Worker. |
| `SENDING_ENABLED` | Versand nur bei exakt `true`, Standard `false`. |
| `SEND_RATE_PER_SECOND` | Versandrate innerhalb der aktuell unterstützten Spanne 1 bis 14, Standard 10. Nicht über das tatsächliche SES-Limit setzen. |
| `SES_REGION` | SES-Region, Standard `us-east-1`. Identitäten und Feedback in derselben Region. |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | Optionale explizite AWS-Zugangsdaten als vollständiges Paar. Sonst Standard-AWS-Credential-Chain. |
| `SES_SESSION_TOKEN` | Sessiontoken für temporäre explizite SES-Zugangsdaten. |
| `SES_CONFIGURATION_SET` | Bei aktiviertem Versand erforderlich. Name mit 1 bis 64 Zeichen, nur Buchstaben, Ziffern, Bindestrich und Unterstrich. |
| `SES_SNS_TOPIC_ARN` | Bei aktiviertem Versand erforderlich. Gültige SNS-Topic-ARN mit zwölfstelliger AWS-Konto-ID, passend zur SES-Region und AWS-Partition. |
| `UPLOAD_STORAGE` | `r2` im Produktivbetrieb. `local` ausschließlich explizit in Entwicklung. |
| `R2_ACCOUNT_ID`, `R2_BUCKET` | Zielkonto und Bucket, keine SES-Werte. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Bucket-beschränktes R2-S3-Schlüsselpaar. |
| `R2_PUBLIC_URL` | Optionale echte öffentliche HTTPS-Asset-URL. Leer für Bildabruf über die App. |
| `UPLOAD_LOCAL_DIR` | Nur beim expliziten lokalen Entwicklungstransport. |
| `ARCHIVE_HOSTS` | Optional, beispielsweise `news.example.com=weekly,news.example.org=monthly`. DNS und TLS separat konfigurieren. |
| `TRUST_PROXY` | Client-IP für Rate-Limits. `cloudflare` liest `CF-Connecting-IP`, `true` den ersten `X-Forwarded-For`-Eintrag eines vertrauenswürdigen Proxys. Leer zählt alle Clients gemeinsam. |
| `ALERT_FROM` | Optionaler Alarm-Absender, muss von einer erlaubten SES-Identität gedeckt sein. Alarmmails gehen über Queue und Worker, also nur bei laufendem Worker und `SENDING_ENABLED=true`. Kein Ersatz für externes Monitoring. |

## CLI und Prüfungen

```bash
npm run build --workspace @vibelabsdotto/vibeletter-cli
npm run cli -- --help
npm run typecheck
npm run lint
npm test
npm run build
```

Die [CLI-Referenz](CLI.md) beschreibt Instanzkontexte, Tokens und Befehle. Verwende getrennte Kontexte für lokale Entwicklung und Produktion. Ein Standardkontext ist kein Schutz vor Schreibzugriffen auf die falsche Instanz.

In Entwicklung ausgestellte API-Schlüssel bleiben dauerhaft auf den ausdrücklich aktivierten lokalen Entwicklungszugang beschränkt, auch nach einem Datenbankwechsel in Produktion. Das gilt ebenfalls für daraus ausgestellte weitere Schlüssel. Erzeuge Produktionsschlüssel nach regulärem Produktionslogin neu. Alt-Schlüssel ohne belegte Ausgabeumgebung werden nicht als Produktionsschlüssel übernommen.

Nach Schemaänderungen generierst du Migrationen mit `npm run db:generate`, prüfst SQL und Journal und wendest sie mit `npm run db:migrate` an. Kein `drizzle-kit push`, kein eigenes Migrationsjournal und keine automatische Operator-Provisionierung im Webstart.

## Wenn etwas nicht funktioniert

- Login nicht verfügbar: URLs, E-Mail-Adresse, Länge und Trennung der Secrets prüfen. Die Anwendung zeigt keinen Produktions-Bypass.
- Queue bleibt liegen: Workerprozess und identische absolute DB-Pfade prüfen. Keine zweite Workerinstanz starten, um einen Fehler zu überdecken.
- Domains nicht erreichbar: Region, Credential-Chain und IAM-Leseberechtigungen prüfen. Leere Schlüssel bedeuten nicht automatisch "offline".
- Bild-Upload meldet fehlende Konfiguration: alle vier R2-Werte und `UPLOAD_STORAGE` prüfen. Ohne R2 gibt es in Produktion keinen lokalen Ersatz.
- Versand bleibt gesperrt: zuerst [SES-Domains](SES-DOMAINS.md) abarbeiten. Ein Konfigurationsfehler darf nicht durch vorzeitiges Aktivieren des Versands umgangen werden.
