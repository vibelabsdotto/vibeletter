import { CliError, object, rememberSecret } from './errors.js';
import type { Selection } from './config.js';

export type Query = Record<string, string | number | boolean | undefined>;
export interface ListResult extends Record<string, unknown> {
  items: Record<string, unknown>[];
  total: number;
  limit: number;
  offset: number;
  issues?: Record<string, unknown>[];
  issuesTotal?: number;
  issuesLimit?: number;
  issuesOffset?: number;
}
export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Query;
  body?: unknown;
  bytes?: Uint8Array;
  mime?: string;
  fileName?: string;
  text?: boolean;
  public?: boolean;
}
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export function segment(value: string): string {
  if (!value || /[\s/?#\\]/.test(value) || value === '.' || value === '..') throw new CliError('Die Kennung ist ungültig.');
  return encodeURIComponent(value);
}

export function recordId(value: string): string {
  if (!/^[a-fA-F0-9]{24}$/.test(value)) throw new CliError('Die Kennung muss genau 24 Hex-Zeichen enthalten.', 'invalid_id');
  return segment(value);
}

export function queueId(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new CliError('Die Queue-ID muss eine positive Dezimalzahl ohne führende Null sein.', 'invalid_job_id');
  return segment(value);
}

export class Client {
  constructor(readonly selection: Selection, readonly timeout = 30_000) {
    rememberSecret(selection.token);
  }

  async request(route: string, options: RequestOptions = {}): Promise<unknown> {
    const method = options.method ?? 'GET';
    if (!options.public && !this.selection.token) {
      throw new CliError('Kein API-Token gesetzt. Verwende VIBELETTER_TOKEN oder context set mit einer sicheren Token-Quelle.', 'missing_token');
    }
    const target = new URL(`${this.selection.instance.replace(/\/+$/, '')}/api/v1${route}`);
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) target.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = { Accept: options.text ? 'text/csv, text/html, text/plain' : 'application/json' };
    if (!options.public && this.selection.token) headers.Authorization = `Bearer ${this.selection.token}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.bytes !== undefined) {
      if (!options.mime) throw new CliError('Für einen Datei-Upload ist ein MIME-Typ erforderlich.');
      headers['Content-Type'] = options.mime;
      if (options.fileName) headers['X-File-Name'] = encodeURIComponent(options.fileName);
    }
    const body = options.bytes !== undefined ? new Uint8Array(options.bytes) : options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const signal = AbortSignal.timeout(this.timeout);
    let response: Response;
    let text: string;
    try {
      response = await fetch(target, {
        method, headers, signal, redirect: 'error', ...(body !== undefined ? { body } : {}),
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new CliError('Die API-Antwort ist zu groß.', 'invalid_response', response.status);
          }
          chunks.push(value);
        }
      }
      text = Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (error instanceof CliError) throw error;
      const mutation = method !== 'GET';
      throw new CliError(mutation
        ? 'Die HTTP-Anfrage ist fehlgeschlagen. Das Ergebnis der Änderung ist unbekannt. Prüfe den Datensatz vor einem erneuten Aufruf.'
        : signal.aborted ? 'Die API-Anfrage hat das Zeitlimit überschritten.' : 'Die API ist nicht erreichbar. Prüfe URL, TLS und Netzwerk.',
      mutation ? 'outcome_unknown' : signal.aborted ? 'timeout' : 'connection_error');
    }
    let data: unknown;
    if (text) {
      try { data = JSON.parse(text); }
      catch {
        if (!response.ok) throw new CliError(`Die API meldet HTTP ${response.status}.`, 'http_error', response.status);
        if (options.text) return text;
        throw new CliError('Die API hat keine gültige JSON-Antwort geliefert.', 'invalid_response', response.status);
      }
    } else if (response.status === 204) {
      return null;
    } else if (response.ok) {
      throw new CliError('Die API-Antwort ist leer.', 'invalid_response', response.status);
    }
    const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
    // Queue inspection returns the delivery error as data, not as an API error envelope.
    const queueJob = method === 'GET' && /^\/queue\/[1-9][0-9]*$/.test(route)
      && record?.id === route.slice('/queue/'.length)
      && ['send-message', 'scheduled-campaign', 'send-alert'].includes(String(record?.kind))
      && ['pending', 'pending_retry', 'running', 'failed'].includes(String(record?.status))
      && typeof record?.error === 'string';
    if (!response.ok || (record?.error && !queueJob) || record?.ok === false) {
      const failure = record?.error;
      const nested = failure && typeof failure === 'object' ? failure as Record<string, unknown> : undefined;
      const message = typeof failure === 'string' ? failure : typeof nested?.message === 'string' ? nested.message
        : typeof record?.message === 'string' ? record.message : `Die API meldet HTTP ${response.status}.`;
      const code = typeof nested?.code === 'string' ? nested.code : typeof record?.code === 'string' ? record.code : 'api_error';
      throw new CliError(message, code, response.status, data);
    }
    if (options.text && typeof data !== 'string') throw new CliError('Die API hat statt einer Textdatei JSON geliefert.', 'invalid_response', response.status);
    return options.text ? String(data) : data;
  }

  async list(resource: string, query: Query = {}): Promise<ListResult> {
    const data = object(await this.request(`/${resource}`, { query }), 'Die Listen-Antwort');
    const collection = (items: unknown, total: unknown, limit: unknown, offset: unknown): Record<string, unknown>[] => {
      if (!Array.isArray(items) || !Number.isSafeInteger(total) || !Number.isSafeInteger(limit)
        || !Number.isSafeInteger(offset) || Number(total) < 0 || Number(limit) < 1 || Number(offset) < 0
        || items.length > Number(limit) || items.length > Math.max(0, Number(total) - Number(offset))) {
        throw new CliError('Die API-Liste muss Einträge und gültige total-, limit- und offset-Werte enthalten.', 'invalid_response');
      }
      return items.map((item) => object(item, 'Ein Listeneintrag'));
    };
    const result: ListResult = {
      ...data, items: collection(data.items, data.total, data.limit, data.offset),
      total: Number(data.total), limit: Number(data.limit), offset: Number(data.offset),
    };
    if (resource === 'campaigns' && ['issues', 'issuesTotal', 'issuesLimit', 'issuesOffset'].some((key) => Object.hasOwn(data, key))) {
      result.issues = collection(data.issues, data.issuesTotal, data.issuesLimit, data.issuesOffset);
      result.issuesTotal = Number(data.issuesTotal);
      result.issuesLimit = Number(data.issuesLimit);
      result.issuesOffset = Number(data.issuesOffset);
    }
    return result;
  }

  async listAll(resource: string, query: Query = {}): Promise<ListResult> {
    const first = await this.list(resource, { ...query, offset: 0, limit: query.limit ?? 100 });
    const collect = async (kind: 'items' | 'issues'): Promise<Record<string, unknown>[]> => {
      const total = kind === 'items' ? first.total : first.issuesTotal!;
      const limit = kind === 'items' ? first.limit : first.issuesLimit!;
      const offset = kind === 'items' ? first.offset : first.issuesOffset!;
      const items = [...(first[kind] ?? [])];
      const identity = (item: Record<string, unknown>): string => String(item._id ?? item.id ?? item.domain ?? JSON.stringify(item));
      const ids = new Set(items.map(identity));
      if (offset !== 0 || ids.size !== items.length) throw new CliError('Die erste API-Seite enthält einen falschen Offset oder doppelte Einträge.', 'invalid_response');
      let nextOffset = items.length;
      while (nextOffset < total) {
        if (!items.length) throw new CliError('Die API-Paginierung liefert keine weiteren Einträge.', 'invalid_response');
        const page = await this.list(resource, { ...query, limit, offset: nextOffset });
        const entries = page[kind];
        const pageOffset = kind === 'items' ? page.offset : page.issuesOffset;
        const pageLimit = kind === 'items' ? page.limit : page.issuesLimit;
        if (page.total !== first.total || page.issuesTotal !== first.issuesTotal
          || pageOffset !== nextOffset || pageLimit !== limit || !entries?.length) {
          throw new CliError('Die Liste hat sich während des Exports geändert. Starte den Export erneut.', 'pagination_changed');
        }
        for (const item of entries) {
          const id = identity(item);
          if (ids.has(id)) throw new CliError('Die API-Paginierung enthält doppelte Einträge.', 'invalid_response');
          ids.add(id);
          items.push(item);
        }
        nextOffset += entries.length;
      }
      if (items.length !== total || ids.size !== items.length) {
        throw new CliError('Die Anzahl der exportierten Einträge stimmt nicht mit total überein.', 'invalid_response');
      }
      return items;
    };
    const items = await collect('items');
    const issues = first.issues === undefined ? undefined : await collect('issues');
    return { ...first, items, offset: 0, ...(issues ? { issues, issuesOffset: 0 } : {}) };
  }
}
