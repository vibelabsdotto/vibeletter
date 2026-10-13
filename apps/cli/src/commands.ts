import path from 'node:path';
import { Command } from 'commander';
import { buildCatalog } from './catalog.js';
import { Client, queueId, recordId, segment, type Query } from './client.js';
import { getContext, listContexts, removeContext, resolveSelection, scope, setContext, showContext, useContext, validateToken, type Scope } from './config.js';
import { encodeCsv, importRows, parseCsv } from './csv.js';
import { CliError, object, redact, rememberSecret } from './errors.js';
import { boolean, integer, isoDate, output, preflightPrivateOutput, readJson, readSource, writePrivate } from './io.js';

type Options = Record<string, unknown>;
interface Invocation { args: string[]; options: Options; command: Command; client: () => Client }
type Handler = (invocation: Invocation) => Promise<unknown> | unknown;
interface Field { flag: string; key: string; description: string; kind?: 'boolean' | 'integer' | 'array' }
const field = (flag: string, key: string, description: string, kind?: Field['kind']): Field => ({ flag, key, description, ...(kind ? { kind } : {}) });
const stringOption = (options: Options, name: string): string | undefined => typeof options[name] === 'string' ? options[name] : undefined;
const requiredString = (data: Record<string, unknown>, name: string): string => {
  const value = data[name];
  if (typeof value !== 'string' || !value) throw new CliError(`${name} ist erforderlich.`);
  return value;
};
const nonnegative = (value: string): number => integer(value);
const commaList = (value: string): string[] => {
  const values = value.split(',');
  if (values.some((item) => !item || item !== item.trim())) throw new CliError('Die Liste muss nicht leere, durch Kommas getrennte Werte ohne Leerzeichen enthalten.');
  return values;
};

function run(command: Command, handler: Handler): Command {
  command.action(async (...args: unknown[]) => {
    const called = args.at(-1) as Command;
    const options = called.optsWithGlobals<Options>();
    if (options.context !== undefined && options.instance !== undefined) throw new CliError('--instance und --context dürfen nicht gemeinsam verwendet werden.');
    const invocation: Invocation = {
      command: called, options, args: args.slice(0, -2) as string[],
      client: () => new Client(resolveSelection({
        ...(stringOption(options, 'context') ? { context: stringOption(options, 'context')! } : {}),
        ...(stringOption(options, 'instance') ? { instance: stringOption(options, 'instance')! } : {}),
      }, called.parent?.name() === 'context' ? options.scope as Scope | undefined : undefined), typeof options.timeout === 'number' ? options.timeout : 30_000),
    };
    const result = await handler(invocation);
    if (result !== undefined) output(result, options.json === true);
  });
  return command;
}

function bodyOptions(command: Command, fields: readonly Field[]): Command {
  command.option('--file <path>', 'JSON-Objekt aus Datei, - liest stdin');
  for (const item of fields) {
    if (item.kind === 'boolean') command.option(`--${item.flag} <value>`, item.description, boolean);
    else if (item.kind === 'integer') command.option(`--${item.flag} <value>`, item.description, nonnegative);
    else if (item.kind === 'array') command.option(`--${item.flag} <value>`, item.description, commaList);
    else command.option(`--${item.flag} <value>`, item.description);
  }
  return command;
}

function optionKey(flag: string): string { return flag.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase()); }

async function payload(options: Options, fields: readonly Field[] = [], content = false): Promise<Record<string, unknown>> {
  const data = stringOption(options, 'file') ? await readJson(stringOption(options, 'file')!) : {};
  for (const item of fields) {
    const value = options[optionKey(item.flag)];
    if (value !== undefined) data[item.key] = value;
  }
  if (content) {
    const htmlFile = stringOption(options, 'htmlFile');
    const markdownFile = stringOption(options, 'markdownFile');
    if (htmlFile && markdownFile) throw new CliError('Verwende nur --html-file oder --markdown-file.');
    if (htmlFile) data.html = (await readSource(htmlFile)).toString('utf8');
    if (markdownFile) data.markdown = (await readSource(markdownFile)).toString('utf8');
    if (typeof data.html === 'string' && data.html.trim() && typeof data.markdown === 'string' && data.markdown.trim()) throw new CliError('Verwende nur html oder markdown, nicht beide.');
  }
  return data;
}

const newsletterFields = [
  field('name', 'name', 'Name des Newsletters'), field('slug', 'slug', 'Newsletter-Slug'),
  field('from-name', 'fromName', 'Absendername'), field('from-email', 'fromEmail', 'Absenderadresse'),
  field('reply-to', 'replyTo', 'Antwortadresse'), field('postal-address', 'postalAddress', 'Postanschrift'),
];
const contactFields = [
  field('newsletter', 'newsletter', 'Newsletter-Slug, keine ID'), field('email', 'email', 'E-Mail-Adresse'),
  field('source', 'source', 'Herkunft'), field('resubscribe', 'resubscribe', 'Erneute Anmeldung: true oder false', 'boolean'),
  field('ip', 'ip', 'Besucher-IP für das API-Rate-Limit'),
];
const campaignFields = [
  field('newsletter', 'newsletter', 'Newsletter-Slug, keine ID'), field('subject', 'subject', 'Betreff'),
  field('preview-text', 'previewText', 'Vorschautext'), field('archive-slug', 'archiveSlug', 'Archiv-Slug'),
  field('format', 'format', 'html, markdown oder rich'), field('audience-limit', 'audienceLimit', 'Maximale Zielgruppe', 'integer'), field('archive-listed', 'archiveListed', 'Im Archiv auflisten: true oder false', 'boolean'),
];

function listOptions(command: Command, resource: string): Command {
  command.option('--limit <number>', 'Seitengröße, 1 bis 100', (value: string) => integer(value, 1, 100), 50)
    .option('--offset <number>', 'Erster Eintrag, ab 0', nonnegative, 0)
    .option('--all', 'Alle Seiten lesen, total und eindeutige IDs prüfen');
  if (['contacts', 'campaigns'].includes(resource)) command.option('--newsletter <slug>', 'Nach Newsletter-Slug filtern');
  if (['contacts', 'campaigns', 'queue'].includes(resource)) command.option('--status <value>', 'Nach Status filtern');
  if (resource === 'contacts') command.option('--search <text>', 'Suchtext, HTTP-Feld q');
  if (resource === 'suppressions') command.option('--reason <value>', 'Nach Sperrgrund filtern');
  if (['contacts', 'suppressions'].includes(resource)) command.option('--email <value>', 'Nach E-Mail-Adresse filtern');
  return command;
}

function queryFrom(options: Options): Query {
  const result: Query = {};
  for (const key of ['newsletter', 'status', 'email', 'reason', 'campaignId', 'timeZone', 'limit', 'offset']) {
    const value = options[key];
    if (typeof value === 'string' || typeof value === 'number') result[key] = value;
  }
  if (typeof options.search === 'string') result.q = options.search;
  return result;
}

function addList(group: Command, resource: string): void {
  run(listOptions(group.command('list').description('Einträge mit Paginierung auflisten'), resource), async ({ options, client }) => {
    if (options.all && options.offset !== 0) throw new CliError('--all darf nicht mit --offset verwendet werden.');
    const result = await (options.all ? client().listAll(resource, queryFrom(options)) : client().list(resource, queryFrom(options)));
    return resource === 'api-keys' ? redact(result) : result;
  });
}

function addCrud(program: Command, name: string, description: string, fields: readonly Field[], required: readonly string[], content = false): Command {
  const group = program.command(name).description(description);
  addList(group, name);
  run(group.command('get <id>').description('Eintrag anhand seiner ID lesen'), ({ args, client }) => client().request(`/${name}/${recordId(args[0]!)}`));
  const create = bodyOptions(group.command('create').description('Eintrag anlegen und die API-Antwort ausgeben'), fields);
  const updateFields = name === 'contacts' ? fields.filter((item) => item.key === 'source') : name === 'campaigns' ? fields.filter((item) => item.key !== 'newsletter') : fields;
  const update = bodyOptions(group.command('update <id>').description('Angegebene Felder mit PATCH ändern'), updateFields);
  if (content) {
    for (const command of [create, update]) command.option('--html-file <path>', 'HTML aus Datei, - liest stdin').option('--markdown-file <path>', 'Markdown aus Datei, - liest stdin');
  }
  run(create, async ({ options, client }) => {
    const body = await payload(options, fields, content);
    for (const key of required) requiredString(body, key);
    return client().request(`/${name}`, { method: 'POST', body });
  });
  run(update, async ({ args, options, client }) => {
    const id = recordId(args[0]!);
    const body = await payload(options, updateFields, content);
    if (!Object.keys(body).length) throw new CliError('Für die Änderung ist mindestens ein Feld erforderlich.');
    return client().request(`/${name}/${id}`, { method: 'PATCH', body });
  });
  run(group.command('delete <id>').description(name === 'campaigns' ? 'Entwurf verwerfen, kein physisches Löschen' : 'Eintrag löschen, API prüft vorhandene Beziehungen').option('--confirm', 'Löschen ausdrücklich bestätigen'), ({ args, options, client }) => {
    const id = recordId(args[0]!);
    if (!options.confirm) throw new CliError('--confirm ist zum Löschen erforderlich.');
    return client().request(`/${name}/${id}`, { method: 'DELETE', body: { confirm: true } });
  });
  return group;
}

function scopeOption(command: Command, defaultScope?: Scope): Command {
  return defaultScope ? command.option('--scope <scope>', 'Konfigurationsdatei: global oder local', scope, defaultScope)
    : command.option('--scope <scope>', 'Nur global oder local lesen', scope);
}

function addContexts(program: Command): void {
  const contexts = program.command('context').description('Private Kontextprofile verwalten');
  run(scopeOption(contexts.command('set <name>').description('Kontext anlegen oder ersetzen, Token nie als Argument')
    .option('--instance <url>', 'App-URL des Kontextes, erforderlich')
    .option('--token-stdin', 'Token aus stdin lesen')
    .option('--token-file <path>', 'Token aus eigener Datei mit Dateirechten 0600 lesen')
    .option('--token-env <name>', 'Token aus benannter Umgebungsvariable lesen')
    .option('--clear-token', 'Gespeichertes Token entfernen'), 'global'), ({ args, options }) => setContext(args[0]!, options.scope as Scope, requiredString(options, 'instance'), {
      ...(options.tokenStdin ? { tokenStdin: true } : {}),
      ...(stringOption(options, 'tokenFile') ? { tokenFile: stringOption(options, 'tokenFile')! } : {}),
      ...(stringOption(options, 'tokenEnv') ? { tokenEnv: stringOption(options, 'tokenEnv')! } : {}),
      ...(options.clearToken ? { clearToken: true } : {}),
    }));
  run(scopeOption(contexts.command('use <name>').description('Standardkontext wählen'), 'global'), ({ args, options }) => useContext(args[0]!, options.scope as Scope));
  run(scopeOption(contexts.command('list').description('Kontexte auflisten, Tokens immer schwärzen')), ({ options }) => ({ items: listContexts(options.scope as Scope | undefined) }));
  run(scopeOption(contexts.command('show [name]').description('Kontext oder effektive Auswahl mit Token-Herkunft lesen')), ({ args, options }) => showContext(args[0], options.scope as Scope | undefined, {
    ...(stringOption(options, 'context') ? { context: stringOption(options, 'context')! } : {}),
    ...(stringOption(options, 'instance') ? { instance: stringOption(options, 'instance')! } : {}),
  }));
  run(scopeOption(contexts.command('remove <name>').description('Kontext und seine gespeicherten Zugangsdaten entfernen'), 'global'), ({ args, options }) => removeContext(args[0]!, options.scope as Scope));
  run(scopeOption(contexts.command('verify [name]').description('Health und authentifizierten API-Zugriff real prüfen')), async ({ args, options, client }) => {
    let connection: Client;
    if (args[0]) {
      if (options.instance !== undefined || options.context !== undefined) throw new CliError('verify <name> darf nicht mit --instance oder --context kombiniert werden.');
      const context = getContext(args[0], options.scope as Scope | undefined);
      const token = process.env.VIBELETTER_TOKEN !== undefined ? validateToken(process.env.VIBELETTER_TOKEN) : context.token;
      connection = new Client({ instance: context.instance, context: context.name, scope: context.scope,
        ...(token ? { token } : {}), instanceSource: `${context.scope}-context`,
        tokenSource: process.env.VIBELETTER_TOKEN !== undefined ? 'environment' : token ? `${context.scope}-context` : 'none',
      }, options.timeout as number);
    } else connection = client();
    const health = await connection.request('/health/details');
    const overview = await connection.request('/overview');
    return { instance: connection.selection.instance, health, overview };
  });
}

async function saveResult(result: unknown, options: Options, type: 'json' | 'preview' = 'json'): Promise<unknown> {
  const out = stringOption(options, 'out');
  if (!out) return result;
  let text: string;
  if (type === 'preview') {
    const data = typeof result === 'string' ? result : object(result, 'Die Vorschau');
    if (typeof data === 'string') text = data;
    else if (typeof data.html === 'string') text = data.html;
    else throw new CliError('Die Vorschau-Antwort enthält kein HTML.', 'invalid_response');
  } else text = `${JSON.stringify(result, null, 2)}\n`;
  writePrivate(out, text);
  return { out: path.resolve(out), bytes: Buffer.byteLength(text) };
}

function addContactFlows(contacts: Command): void {
  run(contacts.command('status <id> <status>').description('Kontaktstatus ändern, active reaktiviert nur dormant'), ({ args, client }) => {
    if (!['active', 'unsubscribed'].includes(args[1]!)) throw new CliError('Ungültiger Kontaktstatus.');
    return client().request(`/contacts/${recordId(args[0]!)}/status`, { method: 'POST', body: { status: args[1] } });
  });
  run(contacts.command('import').description('CSV oder JSON vollständig lesen und in höchstens 1000 Zeilen je Anfrage importieren')
    .requiredOption('--file <path>', 'CSV-Datei oder JSON-Objekt mit rows, - liest stdin')
    .option('--format <format>', 'csv oder json', 'csv')
    .option('--newsletter <slug>', 'Newsletter-Slug, bei CSV erforderlich')
    .option('--source <value>', 'Import-Herkunft')
    .option('--batch-size <number>', 'Zeilen pro HTTP-Anfrage, 1 bis 1000', (value: string) => integer(value, 1, 1000), 1000), async ({ options, client }) => {
      const format = requiredString(options, 'format');
      if (!['csv', 'json'].includes(format)) throw new CliError('--format muss csv oder json sein.');
      const data = format === 'json' ? await readJson(requiredString(options, 'file'))
        : { rows: parseCsv((await readSource(requiredString(options, 'file'))).toString('utf8')) };
      if (options.newsletter !== undefined) data.newsletter = options.newsletter;
      if (options.source !== undefined) data.source = options.source;
      requiredString(data, 'newsletter');
      const rows = importRows(data.rows);
      const batchSize = options.batchSize as number;
      const results: unknown[] = [];
      let submitted = 0;
      const connection = client();
      for (let start = 0; start < rows.length; start += batchSize) {
        const batch = rows.slice(start, start + batchSize);
        try {
          const result = await connection.request('/contacts/import', { method: 'POST', body: { ...data, rows: batch } });
          results.push(result);
          submitted += batch.length;
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          throw new CliError(error.message, error.code, error.status, {
            completedBatches: results.length, rowsSubmitted: submitted, results, failedBatch: results.length + 1,
            failure: error.details,
          });
        }
      }
      return { rowsSubmitted: submitted, batches: results };
    });
  run(contacts.command('export').description('Alle Kontakte mit überprüfter Paginierung als CSV oder JSON exportieren')
    .option('--newsletter <slug>', 'Nach Newsletter-Slug filtern')
    .option('--status <value>', 'Nach Status filtern')
    .option('--email <value>', 'Nach E-Mail-Adresse filtern')
    .option('--search <text>', 'Suchtext, HTTP-Feld q')
    .option('--format <format>', 'csv oder json', 'csv')
    .option('--out <path>', 'Privat und atomar speichern, - schreibt stdout')
    .option('--raw-csv', 'Formelschutz deaktivieren, nur für maschinellen Reimport'), async ({ options, client }) => {
      const format = requiredString(options, 'format');
      if (!['csv', 'json'].includes(format)) throw new CliError('--format muss csv oder json sein.');
      const data = await client().listAll('contacts/export', { ...queryFrom(options), format: 'json' });
      if (format === 'json' && !options.out) return data;
      if (format === 'csv' && options.json && (!options.out || options.out === '-')) throw new CliError('CSV auf stdout kann nicht mit --json verwendet werden. Nutze --format json oder --out.');
      const text = format === 'csv' ? encodeCsv(data.items, options.rawCsv === true) : `${JSON.stringify(data, null, 2)}\n`;
      if (!options.out || options.out === '-') { process.stdout.write(text); return undefined; }
      writePrivate(requiredString(options, 'out'), text);
      return { out: path.resolve(requiredString(options, 'out')), total: data.total, bytes: Buffer.byteLength(text) };
    });
}

function addCampaignActions(campaigns: Command): void {
  const actions: { name: string; description: string; fields: Field[] }[] = [
    { name: 'test', description: 'Testsendung über den gemeinsamen Sender anfordern', fields: [field('to', 'to', 'Testempfänger')] },
    { name: 'send', description: 'Versand starten, nicht automatisch wiederholen', fields: [field('audience-limit', 'audienceLimit', 'Maximale Zielgruppe', 'integer')] },
    { name: 'schedule', description: 'Versand für einen Zeitpunkt mit Zeitzone planen', fields: [field('at', 'scheduledAt', 'ISO-8601-Zeitpunkt mit Z oder UTC-Offset'), field('audience-limit', 'audienceLimit', 'Maximale Zielgruppe', 'integer')] },
    { name: 'unschedule', description: 'Geplanten Versand aufheben', fields: [] },
    { name: 'pause', description: 'Laufenden Versand pausieren', fields: [] },
    { name: 'resume', description: 'Pausierten Versand fortsetzen', fields: [] },
    { name: 'send-more', description: 'Noch nicht erreichte Kontakte anschreiben', fields: [field('additional', 'additional', 'Zusätzliche Kontakte, ohne Wert alle verbleibenden', 'integer')] },
    { name: 'duplicate', description: 'Neuen Entwurf aus dieser Kampagne anlegen', fields: [] },
    { name: 'pin', description: 'Archiv-Pin ausdrücklich setzen oder entfernen', fields: [field('value', 'pinned', 'true oder false', 'boolean')] },
    { name: 'archive-slug', description: 'Archiv-Slug setzen, leere Zeichenfolge entfernt einen Entwurfs-Slug', fields: [field('slug', 'archiveSlug', 'Neuer Archiv-Slug')] },
    { name: 'discard', description: 'Entwurf verwerfen und geplanten Versand stoppen', fields: [] },
    { name: 'cleanup-preview', description: 'Listenbereinigung berechnen, ohne Versand', fields: [] },
  ];
  for (const action of actions) {
    run(bodyOptions(campaigns.command(`${action.name} <id>`).description(action.description), action.fields), async ({ args, options, client }) => {
      const id = recordId(args[0]!);
      const body = await payload(options, action.fields);
      if (body.action !== undefined && body.action !== action.name) throw new CliError('action in der JSON-Datei stimmt nicht mit dem Befehl überein.');
      if (action.name === 'schedule') {
        const date = requiredString(body, 'scheduledAt');
        isoDate(date, 'scheduledAt');
      }
      if (action.name === 'pin' && typeof body.pinned !== 'boolean') throw new CliError('--value true oder --value false ist erforderlich.');
      if (action.name === 'archive-slug' && typeof body.archiveSlug !== 'string' && body.archiveSlug !== null) throw new CliError('--slug ist erforderlich.');
      for (const key of ['audienceLimit', 'additional']) if (body[key] !== undefined && !(key === 'audienceLimit' && body[key] === null) && (!Number.isSafeInteger(body[key]) || Number(body[key]) < 1)) throw new CliError(`${key} muss eine positive ganze Zahl sein.`);
      return client().request(`/campaigns/${id}/actions`, { method: 'POST', body: { ...body, action: action.name } });
    });
  }
  for (const name of ['preview', 'report'] as const) {
    const command = campaigns.command(`${name} <id>`).description(name === 'preview' ? 'Gerendertes HTML lesen' : 'Versand- und Ereignisbericht lesen')
      .option('--out <path>', name === 'preview' ? 'HTML privat und atomar speichern' : 'JSON privat und atomar speichern');
    if (name === 'report') command.option('--limit <number>', 'Nachrichten und Ereignisse je Sammlung und Seite, 1 bis 100', (value: string) => integer(value, 1, 100), 50).option('--offset <number>', 'Erster Eintrag jeder Sammlung, ab 0', nonnegative, 0);
    run(command, async ({ args, options, client }) => {
        const result = await client().request(`/campaigns/${recordId(args[0]!)}/${name}`, { query: name === 'report' ? queryFrom(options) : {} });
        return saveResult(result, options, name === 'preview' ? 'preview' : 'json');
      });
  }
}

function addDomains(program: Command): void {
  const domains = program.command('domains').description('SES-Absenderdomains und DNS verwalten');
  addList(domains, 'domains');
  run(domains.command('account').description('SES-Account, Quoten und Versandfreigabe frisch lesen'), ({ client }) => client().request('/domains/account'));
  run(domains.command('get <domain>').description('Domain und DNS-Einträge lesen'), ({ args, client }) => client().request(`/domains/${segment(args[0]!)}`));
  run(domains.command('dns <domain>').description('DNS-Anforderungen der Domain lesen'), ({ args, client }) => client().request(`/domains/${segment(args[0]!)}/dns`));
  const fields = [field('domain', 'domain', 'Absenderdomain'), field('mail-from-domain', 'mailFromDomain', 'MAIL-FROM-Subdomain'), field('configuration-set-name', 'configurationSetName', 'SES-Konfigurationsset')];
  run(bodyOptions(domains.command('create').description('Domain anlegen und echte DNS-Anforderungen ausgeben'), fields), async ({ options, client }) => {
    const body = await payload(options, fields); requiredString(body, 'domain');
    return client().request('/domains', { method: 'POST', body });
  });
  const verifyFields = [field('mail-from-domain', 'mailFromDomain', 'MAIL-FROM-Subdomain'), field('dkim-signing-enabled', 'dkimSigningEnabled', 'DKIM-Signierung: true oder false', 'boolean')];
  run(bodyOptions(domains.command('verify <domain>').description('Domain-Verifikation beim Provider neu prüfen'), verifyFields), async ({ args, options, client }) => client().request(`/domains/${segment(args[0]!)}/verify`, { method: 'POST', body: await payload(options, verifyFields) }));
}

function addKeys(program: Command): void {
  const keys = program.command('keys').description('API-Schlüssel mit Scopes und Ablauf verwalten');
  addList(keys, 'api-keys');
  run(keys.command('get <id>').description('Schlüssel-Metadaten lesen, nie Klartext'), async ({ args, client }) => redact(await client().request(`/api-keys/${recordId(args[0]!)}`)));
  const fields = [field('name', 'name', 'Schlüsselname'), field('scopes', 'scopes', 'Scopes durch Kommas getrennt, explizit erforderlich', 'array'), field('expires-at', 'expiresAt', 'ISO-8601-Ablaufzeit')];
  run(bodyOptions(keys.command('create').description('Schlüssel anlegen, Klartext nur in dieser API-Antwort')
    .option('--out <path>', 'Vollständige Erstellungsantwort privat speichern statt stdout'), fields), async ({ options, client }) => {
      const body = await payload(options, fields); requiredString(body, 'name');
      if (!Array.isArray(body.scopes) || !body.scopes.length || body.scopes.some((value) => typeof value !== 'string' || !value)) throw new CliError('Eine explizite, nicht leere scopes-Liste ist erforderlich.');
      if (body.expiresAt !== undefined && body.expiresAt !== null) isoDate(requiredString(body, 'expiresAt'), 'expiresAt');
      const out = stringOption(options, 'out');
      if (out) preflightPrivateOutput(out);
      const connection = client();
      const result = await connection.request('/api-keys', { method: 'POST', body });
      if (!out) return result;
      const created = object(result, 'Die Schlüssel-Antwort');
      if (typeof created.key === 'string') rememberSecret(created.key);
      try {
        return await saveResult(result, options);
      } catch (error) {
        // Never infer a key ID from an input, a list, or an ambiguous failed POST.
        const id = typeof created._id === 'string' && /^[a-fA-F0-9]{24}$/.test(created._id)
          && typeof created.key === 'string' && /^vl_[A-Za-z0-9_-]{43}$/.test(created.key)
          ? created._id : undefined;
        let revoked = false;
        let revokeError: unknown;
        if (id) {
          try { await connection.request(`/api-keys/${recordId(id)}`, { method: 'DELETE' }); }
          catch (failure) { revokeError = failure instanceof CliError ? { code: failure.code, details: failure.details } : 'revoke_failed'; }
          try {
            const saved = object(await connection.request(`/api-keys/${recordId(id)}`), 'Die Schlüssel-Metadaten');
            revoked = saved._id === id && typeof saved.revokedAt === 'string' && Number.isFinite(Date.parse(saved.revokedAt));
          } catch (failure) {
            revokeError = failure instanceof CliError ? { code: failure.code, details: failure.details } : 'readback_failed';
          }
        }
        throw new CliError(revoked
          ? 'Die Ausgabedatei konnte nicht gespeichert werden. Der neu angelegte Schlüssel wurde widerrufen und der Widerruf geprüft. Die Erstellung wurde nicht wiederholt.'
          : `Die Ausgabedatei konnte nicht gespeichert werden. Der Widerruf des neu angelegten Schlüssels ist nicht bestätigt. ${id ? `Prüfe den Schlüssel ${id} auf ${connection.selection.instance} und widerrufe ihn manuell.` : 'Die Erstellungsantwort enthält keine eindeutige neue Schlüssel-ID. Prüfe die Schlüssel auf dieser Instanz und widerrufe den neuen Schlüssel manuell.'} Wiederhole die Erstellung nicht blind.`,
        'key_output_failed', 0, {
          out: path.resolve(out), ...(id ? { keyId: id } : {}), revoked,
          outputError: error instanceof CliError ? { code: error.code, message: error.message } : 'file_error',
          ...(revokeError ? { revokeError } : {}),
        });
      }
    });
  run(keys.command('revoke <id>').description('Schlüssel widerrufen'), ({ args, client }) => client().request(`/api-keys/${recordId(args[0]!)}`, { method: 'DELETE' }));
}

function addSuppressions(program: Command): void {
  const suppressions = program.command('suppressions').description('Globale Versandsperren verwalten');
  addList(suppressions, 'suppressions');
  run(suppressions.command('get <id>').description('Globale Versandsperre lesen'), ({ args, client }) => client().request(`/suppressions/${recordId(args[0]!)}`));
  const fields = [field('email', 'email', 'Gesperrte E-Mail-Adresse'), field('reason', 'reason', 'Sperrgrund'), field('detail', 'detail', 'Zusätzliche Angabe')];
  run(bodyOptions(suppressions.command('add').description('Adresse global sperren'), fields), async ({ options, client }) => {
    const body = await payload(options, fields); requiredString(body, 'email'); requiredString(body, 'reason');
    return client().request('/suppressions', { method: 'POST', body });
  });
  run(suppressions.command('remove <id>').description('Globale Sperre entfernen, Kontaktstatus bleibt serverseitig geschützt').option('--confirm', 'Entfernen dieser globalen Sperre ausdrücklich bestätigen'), ({ args, options, client }) => {
    const id = recordId(args[0]!);
    if (!options.confirm) throw new CliError('--confirm ist zum Entfernen einer globalen Sperre erforderlich.');
    return client().request(`/suppressions/${id}`, { method: 'DELETE', body: { confirm: true } });
  });
}

function addQueue(program: Command): void {
  const queue = program.command('queue').description('Persistente Sender-Aufträge prüfen');
  addList(queue, 'queue');
  run(queue.command('get <id>').description('Auftrag anhand seiner positiven Dezimal-ID lesen'), ({ args, client }) => client().request(`/queue/${queueId(args[0]!)}`));
  for (const action of ['retry', 'cancel']) {
    run(queue.command(`${action} <id>`).description(action === 'retry' ? 'Fehlgeschlagenen Auftrag erneut anfordern, API verweigert unklare oder bereits akzeptierte Zustellung' : 'Auftrag abbrechen'), ({ args, client }) => client().request(`/queue/${queueId(args[0]!)}/${action}`, { method: 'POST', body: {} }));
  }
}

function addUploads(program: Command): void {
  const uploads = program.command('uploads').description('Dateien über den konfigurierten Upload-Provider speichern');
  run(uploads.command('create <file>').description('Bildbytes aus Datei oder stdin hochladen, höchstens 4 MiB')
    .option('--mime <type>', 'Expliziter MIME-Typ, sonst aus Dateiendung')
    .option('--name <filename>', 'Dateiname, bei stdin erforderlich'), async ({ args, options, client }) => {
      const filename = stringOption(options, 'name') ?? (args[0] === '-' ? undefined : path.basename(args[0]!));
      if (!filename || filename.includes('/') || filename.includes('\\')) throw new CliError('Ein Dateiname ohne Verzeichnis ist erforderlich.');
      const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
      const mime = stringOption(options, 'mime') ?? types[path.extname(filename).toLowerCase()];
      if (!mime || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) throw new CliError('Uploads unterstützen PNG, JPEG, GIF und WebP. Verwende einen passenden --mime-Wert.');
      const bytes = await readSource(args[0]!, 4 * 1024 * 1024);
      if (!bytes.length) throw new CliError('Die Upload-Datei ist leer.');
      return client().request('/uploads', { method: 'POST', bytes, mime, fileName: filename });
    });
}

export function createProgram(): Command {
  const program = new Command().name('vibeletter').description('VibeLetter Operator-CLI mit privaten Kontextprofilen')
    .version('0.1.0', '-V, --version', 'Versionsnummer ausgeben')
    .helpOption('-h, --help', 'Hilfe zum Befehl anzeigen')
    .addHelpCommand('help [command]', 'Hilfe zu einem Befehl anzeigen')
    .configureHelp({ showGlobalOptions: true })
    .option('--context <name>', 'Kontext für diesen Aufruf wählen')
    .option('--instance <url>', 'App-URL für diesen Aufruf, vor Kontext und Umgebung')
    .option('--json', 'Kompaktes JSON, Fehler als JSON auf stderr')
    .option('--timeout <ms>', 'HTTP-Zeitlimit in Millisekunden', (value: string) => integer(value, 1, 2 ** 31 - 1), 30_000)
    .showHelpAfterError(false).exitOverride();
  program.configureOutput({ writeErr: () => {} });
  program.addHelpText('after', '\nTokens: VIBELETTER_TOKEN, context set --token-file oder --token-stdin. Kein Token-Argument.\nHilfe zu jedem Befehl: vibeletter <Befehl> --help\n');
  addContexts(program);
  run(program.command('catalog').description('Maschinenlesbare Befehle, Optionen und HTTP-Verträge ohne Netzwerk lesen'), () => buildCatalog(program));
  run(program.command('health').description('Authentifizierte API-Readiness lesen'), ({ client }) => client().request('/health/details'));
  run(program.command('readiness').description('Öffentliche Readiness ohne Token lesen'), ({ client }) => client().request('/health', { public: true }));
  run(program.command('overview').description('Operator-Übersicht lesen').option('--newsletter <slug>', 'Newsletter-Slug').option('--time-zone <value>', 'IANA-Zeitzone des Berichts'), ({ options, client }) => client().request('/overview', { query: queryFrom(options) }));
  const newsletters = addCrud(program, 'newsletters', 'Newsletter mit originalen Feldern verwalten', newsletterFields, ['name', 'slug', 'fromEmail']);
  run(newsletters.command('welcome-test <id>').description('Willkommensmail über den gemeinsamen Sender testen').option('--to <email>', 'Testempfänger, sonst ADMIN_EMAIL'), ({ args, options, client }) => client().request(`/newsletters/${recordId(args[0]!)}/actions`, { method: 'POST', body: { action: 'welcome-test', ...(options.to ? { to: options.to } : {}) } }));
  const contacts = addCrud(program, 'contacts', 'Kontakte verwalten, Import sendet keine Willkommensmail', contactFields, ['newsletter', 'email']);
  addContactFlows(contacts);
  const campaigns = addCrud(program, 'campaigns', 'Kampagnen und Versandaktionen verwalten', campaignFields, ['newsletter'], true);
  addCampaignActions(campaigns);
  addDomains(program);
  addKeys(program);
  addSuppressions(program);
  addQueue(program);
  addUploads(program);
  const configure = (command: Command): void => {
    command.helpOption('-h, --help', 'Hilfe zum Befehl anzeigen');
    for (const child of command.commands) configure(child);
  };
  configure(program);
  return program;
}
