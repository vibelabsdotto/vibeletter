import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliError, object, rememberSecret } from './errors.js';
import { assertSafePath, isMissing, readSource, writePrivate } from './io.js';

export type Scope = 'local' | 'global';
interface Context { instance: string; token?: string }
interface Config {
  version: 1;
  currentContext?: string;
  contexts: Record<string, Context>;
  instance?: string;
  token?: string;
}
export interface SelectionFlags { context?: string; instance?: string }
export interface Selection {
  instance: string;
  token?: string;
  context?: string;
  scope?: Scope;
  instanceSource: string;
  tokenSource: string;
}
export interface TokenInput { tokenStdin?: boolean; tokenFile?: string; tokenEnv?: string; clearToken?: boolean }

export function scope(value: string): Scope {
  if (value !== 'global' && value !== 'local') throw new CliError('--scope muss global oder local sein.');
  return value;
}

export function configPath(which: Scope): string {
  return which === 'global'
    ? path.join(os.homedir(), '.config', 'vibeletter', 'config.json')
    : path.join(process.cwd(), '.vibeletter', 'config.json');
}

export function contextName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new CliError('Der Kontextname muss 1 bis 64 Buchstaben, Ziffern, Unterstriche oder Bindestriche enthalten.');
  }
  return value;
}

export function validateInstance(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim()) throw new CliError('Die Instanz muss eine HTTP(S)-URL ohne Leerzeichen sein.');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new CliError('Die Instanz muss eine gültige HTTP(S)-URL sein.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CliError('Die Instanz-URL darf keine Zugangsdaten, Query-Parameter oder Fragmente enthalten.');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new CliError('HTTPS ist erforderlich. HTTP ist nur für Loopback-Instanzen erlaubt.');
  }
  return value;
}

export function validateToken(value: unknown): string {
  if (typeof value === 'string') rememberSecret(value);
  if (typeof value !== 'string' || !/^vl_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new CliError('Das Token muss vl_ und genau 43 Base64url-Zeichen enthalten.', 'invalid_token');
  }
  return value;
}

function load(which: Scope): Config {
  const file = configPath(which);
  let raw: string;
  try {
    assertSafePath(file);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new CliError(`Die Konfigurationsdatei muss dir gehören und Dateirechte 0600 haben: ${file}`, 'unsafe_config');
    }
    if (stat.size > 1024 * 1024) throw new CliError('Die Konfigurationsdatei ist zu groß.', 'invalid_config');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const current = fs.fstatSync(fd);
      if (current.dev !== stat.dev || current.ino !== stat.ino || !current.isFile() || (current.mode & 0o077) !== 0 || current.size > 1024 * 1024 || (process.getuid && current.uid !== process.getuid())) throw new CliError('Die Konfigurationsdatei wurde während des Lesens geändert.', 'unsafe_config');
      raw = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (isMissing(error)) return { version: 1, contexts: Object.create(null) as Record<string, Context> };
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new CliError(`Ungültiges JSON in ${file}. Die Datei wird nicht überschrieben.`, 'invalid_config'); }
  const data = object(parsed, 'Die Konfiguration');
  if (data.version !== undefined && data.version !== 1) throw new CliError('Die Konfigurationsversion wird nicht unterstützt.', 'invalid_config');
  if (Object.keys(data).some((key) => !['version', 'currentContext', 'contexts', 'instance', 'token'].includes(key))) {
    throw new CliError('Die Konfiguration enthält unbekannte Felder.', 'invalid_config');
  }
  const entries = object(data.contexts ?? {}, 'contexts');
  const contexts: Record<string, Context> = Object.create(null) as Record<string, Context>;
  for (const [name, entry] of Object.entries(entries)) {
    contextName(name);
    const item = object(entry, 'Der Kontext');
    if (Object.keys(item).some((key) => !['instance', 'token'].includes(key))) throw new CliError('Der Kontext enthält unbekannte Felder.', 'invalid_config');
    contexts[name] = { instance: validateInstance(item.instance), ...(item.token !== undefined ? { token: validateToken(item.token) } : {}) };
  }
  if (data.currentContext !== undefined && typeof data.currentContext !== 'string') throw new CliError('currentContext muss ein Kontextname sein.', 'invalid_config');
  return {
    version: 1, contexts,
    ...(typeof data.currentContext === 'string' ? { currentContext: contextName(data.currentContext) } : {}),
    ...(data.instance !== undefined ? { instance: validateInstance(data.instance) } : {}),
    ...(data.token !== undefined ? { token: validateToken(data.token) } : {}),
  };
}

function save(which: Scope, config: Config): void {
  const file = configPath(which);
  const dir = path.dirname(file);
  assertSafePath(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  writePrivate(file, `${JSON.stringify(config, null, 2)}\n`);
}

export function getContext(name: string, which?: Scope): Context & { name: string; scope: Scope } {
  contextName(name);
  for (const candidate of which ? [which] : ['local', 'global'] as const) {
    const entry = load(candidate).contexts[name];
    if (entry) return { ...entry, name, scope: candidate };
  }
  throw new CliError(`Kontext nicht gefunden: ${name}`, 'context_not_found');
}

export function listContexts(which?: Scope): unknown[] {
  return (which ? [which] : ['local', 'global'] as const).flatMap((candidate) => {
    const config = load(candidate);
    return Object.entries(config.contexts).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, entry]) => ({
      name, scope: candidate, instance: entry.instance, token: entry.token ? '[REDACTED]' : null,
      selected: config.currentContext === name, file: configPath(candidate),
    }));
  });
}

export async function readTokenInput(options: TokenInput): Promise<string | undefined> {
  const sources = [Boolean(options.tokenStdin), options.tokenFile !== undefined, options.tokenEnv !== undefined];
  if (sources.filter(Boolean).length > 1) throw new CliError('Verwende genau eine Token-Quelle.');
  if (options.clearToken && sources.some(Boolean)) throw new CliError('--clear-token darf nicht mit einer Token-Quelle verwendet werden.');
  if (options.clearToken) return undefined;
  if (options.tokenStdin || options.tokenFile) {
    const text = (await readSource(options.tokenStdin ? '-' : options.tokenFile!, 256, true)).toString('utf8').replace(/\r?\n$/, '');
    return validateToken(text);
  }
  const name = options.tokenEnv ?? 'VIBELETTER_TOKEN';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new CliError('Der Name der Umgebungsvariable ist ungültig.');
  const value = process.env[name];
  if (options.tokenEnv && value === undefined) throw new CliError('Die gewählte Token-Umgebungsvariable ist nicht gesetzt.', 'missing_token');
  return value === undefined ? undefined : validateToken(value);
}

export async function setContext(name: string, which: Scope, instance: string, options: TokenInput): Promise<unknown> {
  contextName(name);
  validateInstance(instance);
  const config = load(which);
  const previous = config.contexts[name];
  const supplied = await readTokenInput(options);
  const token = options.clearToken ? undefined : supplied ?? (previous?.instance === instance ? previous.token : undefined);
  config.contexts[name] = { instance, ...(token ? { token } : {}) };
  save(which, config);
  const saved = getContext(name, which);
  return { name, scope: which, instance: saved.instance, token: saved.token ? '[REDACTED]' : null, file: configPath(which) };
}

export function useContext(name: string, which: Scope): unknown {
  getContext(name, which);
  const config = load(which);
  config.currentContext = name;
  save(which, config);
  return { currentContext: load(which).currentContext, scope: which, file: configPath(which) };
}

export function removeContext(name: string, which: Scope): unknown {
  contextName(name);
  const config = load(which);
  if (!config.contexts[name]) throw new CliError(`Kontext nicht gefunden in ${which}: ${name}`, 'context_not_found');
  delete config.contexts[name];
  if (config.currentContext === name) delete config.currentContext;
  save(which, config);
  if (load(which).contexts[name]) throw new CliError('Der Kontext konnte nicht entfernt werden.', 'config_write_error');
  return { removed: name, scope: which };
}

export function resolveSelection(flags: SelectionFlags, which?: Scope): Selection {
  if (flags.context !== undefined && flags.instance !== undefined) throw new CliError('--instance und --context dürfen nicht gemeinsam verwendet werden.');
  const empty: Config = { version: 1, contexts: {} };
  const local = which === 'global' ? empty : load('local');
  const global = which === 'local' ? empty : load('global');
  const selectedName = flags.context ?? local.currentContext ?? global.currentContext;
  const selected = selectedName ? getContext(selectedName, which ?? (flags.context || local.currentContext ? undefined : 'global')) : undefined;
  const configured = local.instance ? local : global;
  const instance = validateInstance(flags.instance ?? (flags.context ? selected?.instance : process.env.VIBELETTER_INSTANCE)
    ?? selected?.instance ?? local.instance ?? global.instance ?? 'http://localhost:3035');
  const sameInstance = (value: string): boolean => value.replace(/\/+$/, '') === instance.replace(/\/+$/, '');
  const contextToken = selected && sameInstance(selected.instance) ? selected.token : undefined;
  const defaultToken = configured.instance && sameInstance(configured.instance) ? configured.token : undefined;
  const envToken = process.env.VIBELETTER_TOKEN;
  const token = envToken !== undefined ? validateToken(envToken) : contextToken ?? defaultToken;
  return {
    instance,
    ...(token ? { token } : {}),
    ...(selected ? { context: selected.name, scope: selected.scope } : {}),
    instanceSource: flags.instance ? 'flag' : flags.context ? 'context-flag' : process.env.VIBELETTER_INSTANCE ? 'environment'
      : selected ? `${selected.scope}-context` : local.instance ? 'local-default' : global.instance ? 'global-default' : 'default',
    tokenSource: envToken !== undefined ? 'environment' : contextToken ? `${selected!.scope}-context` : defaultToken ? 'config-default' : 'none',
  };
}

export function showContext(name?: string, which?: Scope, flags: SelectionFlags = {}): unknown {
  if (name) {
    const entry = getContext(name, which);
    return { ...entry, token: entry.token ? '[REDACTED]' : null, file: configPath(entry.scope) };
  }
  const selected = resolveSelection(flags, which);
  return { ...selected, token: selected.token ? '[REDACTED]' : null };
}
