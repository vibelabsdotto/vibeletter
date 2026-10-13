# SES-Absenderdomains und Feedback einrichten

Diese Anleitung verwendet `us-east-1`. Setze `SES_REGION` entsprechend und bleibe für Identitäten, Konfigurationsset und SNS in derselben Region. Die folgenden AWS-Schreibbefehle sind bewusst als solche gekennzeichnet. Das Lesen dieser Anleitung legt keine Ressourcen an und verschickt keine Mail.

Halte VibeLetter zunächst auf `SENDING_ENABLED=false`. DNS-Verifikation und eine erfolgreiche SES-Annahme allein sind keine vollständige Versandabnahme.

## Absender, Webdomain und Postfach unterscheiden

| Zweck | Beispiel | Einrichtung |
| --- | --- | --- |
| Dashboard und Empfängerlinks | `letter.example.com` | DNS zum Webhost, TLS, `APP_URL` und `BETTER_AUTH_URL` |
| Öffentlicher Newsletter-Absender | `updates@mail.example.com` | SES-Identität `mail.example.com`, DKIM und DMARC |
| MAIL FROM für SPF und Rückläufer | `bounce.mail.example.com` | Dedizierte Subdomain mit SES-MX und SPF-TXT |
| Reply-To und Antworten | `support@example.com` | Wirkliches Postfach oder Weiterleitung bei einem Mailanbieter |
| Optionales öffentliches Archiv | `news.example.com` | DNS zum Webhost, TLS, `ARCHIVE_HOSTS` |

SES-Verifikation erstellt kein Postfach und keinen IMAP-/Webmail-Zugang. SES hat einen getrennten Empfangsdienst, aber auch dieser ist kein normales Mailboxprodukt. Setze Reply-To auf eine tatsächlich erreichbare Adresse. Ersetze für MAIL FROM nicht die MX-Einträge deiner normalen Postfachdomain.

Eine verifizierte Domain erlaubt den Versand von Adressen darunter. Eine einzelne verifizierte E-Mail-Adresse erlaubt nicht den Versand von anderen Adressen derselben Domain. Die Verifikation von `mail.example.com` deckt beispielsweise nicht `operator@example.com` ab.

## Konto und Region zuerst prüfen

Read-only:

```bash
aws sesv2 get-account --region us-east-1 \
  --query '{Production:ProductionAccessEnabled,Sending:SendingEnabled,Quota:SendQuota}'
aws sesv2 list-email-identities --region us-east-1
```

Neue Konten können im Sandbox-Modus sein. Beantrage in der ausgewählten Region Produktionszugang, wenn du an nicht verifizierte Empfänger senden musst. Production access und `SendingEnabled` sind getrennte Zustände. Beide müssen den Versand erlauben.

Die Tagesquote ist ein rollierendes 24-Stunden-Empfängerlimit. Die Rate und Quote gehören zum AWS-Konto in der Region, nicht zu einer Domain. Mehrere Newsletter und Domains teilen sie. Andere Anwendungen im selben Konto verbrauchen ebenfalls Quote. Eine neue Domain erhöht das Limit nicht.

VibeLetter unterstützt aktuell `SEND_RATE_PER_SECOND` von 1 bis 14, Standard 10. Wähle einen Wert unter oder höchstens auf deinem tatsächlichen SES-Limit und lasse Spielraum für andere Sender. Bestätigungs-, Willkommens-, Test- und Alarmmails gehören ebenfalls zur Versandlast. Ein OSS-Default beweist nicht, dass dein AWS-Konto diese Rate erlaubt.

Identitäten, Produktionsfreigabe, Quoten und Feedbackeinstellungen sind regional. Eine normale Easy-DKIM-Identität in `us-east-1` ist nicht automatisch in `eu-central-1` eingerichtet. AWS DEED-Replikas sind eine ausdrückliche Ausnahme beim DKIM-DNS, nicht bei Quoten oder Sandbox-Status.

## Jede Absenderdomain getrennt verifizieren

Für `mail.example.com` und `letter.example.org` braucht jede Domain eine eigene SES-Identität und eigene DNS-Einträge. Nutze keine erfundenen DKIM-Tokens und kopiere die Tokens der ersten Domain nicht auf die zweite.

Im SES-Dashboard der gewählten Region erstellst du eine Domainidentität mit Easy DKIM und RSA 2048. Alternativ, mutierend und nur für eine noch nicht vorhandene Identität:

```bash
aws sesv2 create-email-identity --region us-east-1 \
  --email-identity mail.example.com \
  --dkim-signing-attributes '{"NextSigningKeyLength":"RSA_2048_BIT"}'
```

Lies danach die tatsächlichen Werte zurück:

```bash
aws sesv2 get-email-identity --region us-east-1 \
  --email-identity mail.example.com \
  --query '{Verified:VerifiedForSendingStatus,DKIM:DkimAttributes,MailFrom:MailFromAttributes}'
```

### Easy DKIM

Normales Easy DKIM liefert drei CNAMEs pro Identität. Das folgende Muster ist keine direkt verwendbare DNS-Konfiguration:

| Typ | Name | Ziel |
| --- | --- | --- |
| CNAME | `<token-1>._domainkey.mail.example.com` | `<token-1>.<SigningHostedZone>` |
| CNAME | `<token-2>._domainkey.mail.example.com` | `<token-2>.<SigningHostedZone>` |
| CNAME | `<token-3>._domainkey.mail.example.com` | `<token-3>.<SigningHostedZone>` |

Nimm die genauen Records aus SES oder der Domains-API. Der häufige Ziel-Suffix ist `dkim.amazonses.com`, aber AWS liefert auch andere `SigningHostedZone`-Werte. Einen Regionssuffix nicht pauschal durch diesen Standard ersetzen.

Bei Cloudflare müssen die DKIM-CNAMEs "DNS only" sein, nicht HTTP-proxied. DNS-Provider können die Zonenendung automatisch anhängen. Prüfe die tatsächlich veröffentlichten vollständigen Namen, damit nicht versehentlich `mail.example.com.mail.example.com` entsteht.

Wiederhole das mit den eigenen drei Tokens für `letter.example.org`. Vor dem Versand muss SES `VerifiedForSendingStatus=true` und DKIM `Status=SUCCESS` mit aktiviertem Signing melden. Die DNS-Verifikation kann bis zu 72 Stunden dauern. Lösche eine wartende Identität nicht als erste Fehlerbehebung.

### Eigene MAIL FROM-Subdomain

Mutierend:

```bash
aws sesv2 put-email-identity-mail-from-attributes --region us-east-1 \
  --email-identity mail.example.com \
  --mail-from-domain bounce.mail.example.com \
  --behavior-on-mx-failure REJECT_MESSAGE
```

Veröffentliche an der dedizierten Subdomain:

| Domainidentität | Typ | Name | Wert in `us-east-1` |
| --- | --- | --- | --- |
| `mail.example.com` | MX | `bounce.mail.example.com` | `10 feedback-smtp.us-east-1.amazonses.com` |
| `mail.example.com` | TXT | `bounce.mail.example.com` | `v=spf1 include:amazonses.com ~all` |
| `letter.example.org` | MX | `bounce.letter.example.org` | `10 feedback-smtp.us-east-1.amazonses.com` |
| `letter.example.org` | TXT | `bounce.letter.example.org` | `v=spf1 include:amazonses.com ~all` |

Die zweite Identität braucht ihren eigenen MAIL FROM-Konfigurationsschritt. An jeder MAIL FROM-Subdomain darf genau ein MX stehen. Veröffentliche nicht mehrere SPF-Records am selben Namen. Ändere weder die normalen Postfach-MX noch vorhandene SPF-Policies anderer Namen auf Verdacht.

`REJECT_MESSAGE` verhindert den stillen Rückfall auf einen `amazonses.com`-MAIL-FROM bei einem MX-Fehler. `USE_DEFAULT_VALUE` würde einen solchen Fallback zulassen und die kundeneigene SPF-Ausrichtung verlieren. DKIM kann DMARC trotzdem erfüllen, aber das ist kein Ersatz für die beabsichtigte MAIL FROM-Konfiguration.

Prüfe `MailFromDomainStatus=SUCCESS` und die richtige Subdomain per `get-email-identity`. Der passende MX-Hostname hängt von der SES-Region ab.

### DMARC pro sichtbarer Absenderdomain

DMARC prüft, ob die sichtbare From-Domain zu einem erfolgreichen DKIM- oder SPF-Ergebnis ausgerichtet ist. Ein ausgerichteter Mechanismus reicht. SPF ohne passende Ausrichtung genügt nicht.

Beispiel für eine anfängliche Monitoringpolicy:

| Typ | Name | Wert |
| --- | --- | --- |
| TXT | `_dmarc.mail.example.com` | `v=DMARC1; p=none; adkim=r; aspf=r` |
| TXT | `_dmarc.letter.example.org` | `v=DMARC1; p=none; adkim=r; aspf=r` |

Eine bereits bestehende Policy der organisatorischen Domain kann Subdomains abdecken. Prüfe deren `p`-/`sp`-Wirkung, bevor du separate Einträge setzt oder vorhandene Policies änderst. Auch eine zweite organisatorische Domain braucht ihre eigene passende DMARC-Konfiguration.

`p=none` überwacht, erzwingt aber keine Zurückweisung. Füge `rua=mailto:...` nur mit einer echten Reportadresse oder einem Reportdienst hinzu. Eine SES-verifizierte Adresse ist dafür noch kein empfangendes Postfach. Prüfe Reports und gehe bewusst zu `quarantine` oder `reject` über.

Beim SES-MAIL-FROM als Subdomain brauchst du relaxed SPF alignment, `aspf=r`. Strict SPF alignment verlangt einen exakten Domainmatch und passt nicht zu diesem Aufbau. Für `adkim=s` muss der DKIM-`d=`-Wert exakt zur sichtbaren From-Domain passen. Parent-Domain-Signing für eine andere Subdomain braucht relaxed alignment oder eine passende exakte DKIM-Identität.

## IAM auf die verwendeten Identitäten begrenzen

Der IAM-Präfix ist `ses:`, auch für SESv2. VibeLetter verwendet die SESv2-`SendEmail`-API. Deren Raw-Content benötigt `ses:SendEmail`, nicht automatisch `ses:SendRawEmail`. SMTP oder die ältere separate RawEmail-API würden `ses:SendRawEmail` benötigen.

Beispiel für einen Runtime-Sender mit zwei Domains und einem vorhandenen Konfigurationsset. Ersetze Beispielaccount, Region und Namen durch deine Werte:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SendApprovedIdentities",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": [
        "arn:aws:ses:us-east-1:123456789012:identity/mail.example.com",
        "arn:aws:ses:us-east-1:123456789012:identity/letter.example.org",
        "arn:aws:ses:us-east-1:123456789012:configuration-set/vibeletter"
      ]
    },
    {
      "Sid": "ReadAccountAndIdentityList",
      "Effect": "Allow",
      "Action": ["ses:GetAccount", "ses:ListEmailIdentities"],
      "Resource": "*"
    },
    {
      "Sid": "ReadApprovedIdentities",
      "Effect": "Allow",
      "Action": "ses:GetEmailIdentity",
      "Resource": [
        "arn:aws:ses:us-east-1:123456789012:identity/mail.example.com",
        "arn:aws:ses:us-east-1:123456789012:identity/letter.example.org"
      ]
    }
  ]
}
```

Die Domains-Liste liest Details aller zurückgegebenen Domainidentitäten. Wenn dasselbe Konto zusätzliche Domains enthält, ergänze deren read-only Identitäts-ARNs oder erlaube `GetEmailIdentity` für die Identitäten des Kontos. Das erweitert nicht automatisch die getrennte Sendeberechtigung. Verwende bei Bedarf `ses:FromAddress` als zusätzliche Einschränkung.

Ein Alarm- oder Test-Absender außerhalb dieser Domains braucht ebenfalls eine passende verifizierte Identität und IAM-Erlaubnis. Eine einzeln verifizierte Adresse ist kein Ersatz für die Domain-ARN einer anderen From-Adresse.

Die Runtime-Policy erstellt keine Domains und ändert kein DNS. Für Domains `create`/`verify` braucht die Serverrolle zusätzlich die gezielt freigegebenen Aktionen `ses:CreateEmailIdentity`, `ses:PutEmailIdentityDkimAttributes`, `ses:PutEmailIdentityDkimSigningAttributes` und `ses:PutEmailIdentityMailFromAttributes`. Vergib sie nur, wenn du diesen mutierenden App-/CLI-Weg wirklich nutzt. Alternativ provisionierst du mit einem getrennten AWS-Operator und behältst die Runtime read/send-only.

Eine SES-Identity-Resource-Policy für delegierten oder kontoübergreifenden Versand ist etwas anderes als diese IAM-Policy. Dafür sind zusätzlich passende Sending-Authorization-Regeln und die Identitäts-ARN im Senderequest nötig. Das einfache Self-Hosting-Beispiel setzt dasselbe AWS-Konto für Identität und Sender voraus.

## SES-Ereignisse an verifiziertes SNS-Feedback anschließen

VibeLetter verwendet `/api/webhooks/ses` und `SES_SNS_TOPIC_ARN`. Ein eingetragener ARN allein beweist weder ein bestätigtes Abonnement noch erfolgreich verarbeitete Bounces.

1. Erstelle in der SES-Region ein Konfigurationsset, beispielsweise `vibeletter`. Lass SES-Open-/Clicktracking aus, wenn die App selbst Tracking verwendet.
2. Erstelle ein SNS-Topic vom Typ Standard in derselben Region. SES unterstützt hierfür kein FIFO-Topic.
3. Erlaube dem Service `ses.amazonaws.com` das Publizieren auf genau dieses Topic. Beschränke `AWS:SourceAccount` und den passenden `AWS:SourceArn`.
4. Ergänze am Konfigurationsset eine aktivierte SNS-Eventdestination für Bounce, Complaint, Delivery, Delivery delay, Reject und Rendering failure. Die API-Ereignisnamen sind `BOUNCE`, `COMPLAINT`, `DELIVERY`, `DELIVERY_DELAY`, `REJECT`, `RENDERING_FAILURE`.
5. Setze `SES_CONFIGURATION_SET=vibeletter` und den exakten `SES_SNS_TOPIC_ARN` in Web und Worker. Starte beide mit der geänderten Umgebung neu.
6. Lege eine HTTPS-Subscription für `https://<app-domain>/api/webhooks/ses` an. Raw message delivery muss aus bleiben, damit der signierte SNS-Envelope ankommt.
7. Prüfe in SNS, dass die Subscription bestätigt wurde, nicht `PendingConfirmation`. Die App verarbeitet beziehungsweise bestätigt nur erlaubte, signierte SNS-Nachrichten. Ohne funktionierenden Endpoint kommt kein Feedback an.

Topic-Policy für Konfigurationsset-Eventpublishing, zusätzlich zur eventuell vorhandenen Verwaltungspolicy des Topics:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "AllowSesConfigurationSet",
    "Effect": "Allow",
    "Principal": { "Service": "ses.amazonaws.com" },
    "Action": "sns:Publish",
    "Resource": "arn:aws:sns:us-east-1:123456789012:vibeletter-ses-events",
    "Condition": {
      "StringEquals": {
        "AWS:SourceAccount": "123456789012",
        "AWS:SourceArn": "arn:aws:ses:us-east-1:123456789012:configuration-set/vibeletter"
      }
    }
  }]
}
```

Bei identitätsbasierten SNS-Benachrichtigungen wäre der SourceArn stattdessen `...:identity/<identity>`. Verwechsle diese zwei Wege nicht. Wenn du beide bewusst nutzt, brauchst du passende Policy-Statements und musst doppelte Events berücksichtigen. Separat verifizierte E-Mail-Identitäten können eigene Feedbackeinstellungen haben, die Parent-Domaineinstellungen überschreiben.

AWS empfiehlt SNS-Signaturversion 2. Mutierend:

```bash
aws sns set-topic-attributes --region us-east-1 \
  --topic-arn arn:aws:sns:us-east-1:123456789012:vibeletter-ses-events \
  --attribute-name SignatureVersion --attribute-value 2
```

Die App muss zuerst Topic und Signatur des Envelopes prüfen und danach das SES-JSON im `Message`-Feld verarbeiten. Ein beliebiger JSON-POST ist kein gültiger SES-Test. Für ein KMS-verschlüsseltes Topic sind außerdem passende KMS-Berechtigungen für SES erforderlich. Lass bestehendes E-Mail-Feedback eingeschaltet, bis der automatische Pfad nachweislich funktioniert.

Read-only prüfen:

```bash
aws sesv2 get-configuration-set-event-destinations --region us-east-1 \
  --configuration-set-name vibeletter
aws sns get-topic-attributes --region us-east-1 \
  --topic-arn arn:aws:sns:us-east-1:123456789012:vibeletter-ses-events
aws sns list-subscriptions-by-topic --region us-east-1 \
  --topic-arn arn:aws:sns:us-east-1:123456789012:vibeletter-ses-events
```

## Simulatoren und Versandabnahme

Simulatoradressen sind keine importierte Zielgruppe:

| Adresse | Prüft |
| --- | --- |
| `success@simulator.amazonses.com` | Erfolgreiche Annahme und Delivery-Feedback |
| `bounce@simulator.amazonses.com` | Bounce-Feedback |
| `complaint@simulator.amazonses.com` | Complaint-Feedback |

Prüfe diese Fälle getrennt. SES-Simulatoren beeinflussen die Bounce-/Complaint-Reputation nicht und verbrauchen keine tägliche Versandquote. Sie ersetzen keine Prüfung der tatsächlich funktionierenden Queue und Webhookverarbeitung.

Der folgende Befehl verschickt eine echte SES-Simulatormail. Er umgeht die App-Queue und `SENDING_ENABLED`, weil die AWS CLI SES direkt aufruft. Nutze ihn nur für die explizit freigegebene Providerprüfung:

```bash
aws sesv2 send-email --region us-east-1 \
  --from-email-address updates@mail.example.com \
  --configuration-set-name vibeletter \
  --destination '{"ToAddresses":["bounce@simulator.amazonses.com"]}' \
  --content '{"Simple":{"Subject":{"Data":"SES simulator check"},"Body":{"Text":{"Data":"Authorized feedback check"}}}}'
```

Eine solche Direktmail hat möglicherweise keinen passenden VibeLetter-Nachrichtendatensatz. Sie kann das SNS-Routing prüfen, aber nicht allein die App-Suppression oder Kampagnenstatistik belegen. Für die vollständige Abnahme verwende zusätzlich einen bewusst angelegten, ausschließlich aus Simulatoradressen bestehenden Testnewsletter und den App-Queue-/Sendepfad. Aktiviere Versand hierfür nur in einer isolierten Instanz ohne importierte Kontakte oder andere ausstehende Sendungen.

Prüfe dauerhaft gespeicherte Ereignisse, Nachrichtenzustand und die erwartete globale Sperre nach Bounce beziehungsweise Complaint. Ein Delivery-Event bedeutet Annahme durch den Zielmailserver, nicht Inbox-Platzierung. Wiederholte oder verspätete SNS-Nachrichten dürfen keinen erneuten Versand auslösen.

Schalte erst nach diesen Prüfungen den produktiven Versand frei. Importiere nur Kontakte mit gültiger Einwilligung. Erwärme neue Domains mit einer bewusst kleinen Zielgruppe und überwache Beschwerden und Bounces. Mehrere From-Domains schützen nicht automatisch vor kontoweiten SES-Einschränkungen.

## Domains über VibeLetter verwalten

Die Operator-API und CLI können SES-Domains auflisten, lesen, anlegen und Signing-/MAIL-FROM-Einstellungen aktualisieren. Sie schreiben keine DNS-Einträge beim Registrar. `verify` ist ein mutierender AWS-Aufruf, kein lokaler Schalter auf "verified". AWS entscheidet den tatsächlichen DNS-Status.

Nutze `domains get` für einen frischen read-only Status und lies nach einer Änderung dieselbe Domain zurück. Bei Timeout oder unklarem AWS-Ausgang zuerst lesen, nicht blind dieselbe Identität erneut erstellen. Die genauen Befehle und Bodyfelder stehen in [CLI.md](CLI.md).

## Offizielle Referenzen

- [Identitäten und Easy DKIM](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [Custom MAIL FROM](https://docs.aws.amazon.com/ses/latest/dg/mail-from.html)
- [DMARC-Ausrichtung](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)
- [SES-Regionen](https://docs.aws.amazon.com/ses/latest/dg/regions.html)
- [Versandquoten](https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html)
- [SESv2-IAM-Aktionen und Ressourcen](https://docs.aws.amazon.com/service-authorization/latest/reference/list_sesv2.html)
- [SNS-Eventdestination am Konfigurationsset](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-sns.html)
- [Identitätsbasierte SNS-Benachrichtigungen](https://docs.aws.amazon.com/ses/latest/dg/configure-sns-notifications.html)
- [SNS-Signaturen prüfen](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)
- [SES-Mailboxsimulator](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html)
