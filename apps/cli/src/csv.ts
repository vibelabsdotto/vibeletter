import { CliError, object } from './errors.js';
import { isoDate } from './io.js';

/** RFC 4180 reader: CRLF/LF, embedded newlines, escaped quotes, BOM. */
export function parseCsv(text: string): Record<string, unknown>[] {
  const source = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let closed = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closed = true; }
      } else field += char;
      continue;
    }
    if (char === '"') {
      if (field || closed) throw new CliError('Ungültige Anführungszeichen in der CSV-Datei.', 'invalid_csv');
      quoted = true;
    } else if (char === ',') {
      row.push(field); field = ''; closed = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      row.push(field); records.push(row); row = []; field = ''; closed = false;
    } else {
      if (closed) throw new CliError('Nach einem CSV-Anführungszeichen muss ein Komma oder Zeilenende folgen.', 'invalid_csv');
      field += char;
    }
  }
  if (quoted) throw new CliError('Die CSV-Datei enthält ein offenes Anführungszeichen.', 'invalid_csv');
  if (field || row.length || closed) { row.push(field); records.push(row); }
  const headers = records.shift();
  if (!headers?.length || new Set(headers).size !== headers.length || headers.some((header) => !header)) {
    throw new CliError('Die CSV-Datei benötigt eindeutige, nicht leere Spaltennamen.', 'invalid_csv');
  }
  const aliases: Record<string, string> = {
    email: 'email', emailaddress: 'email', subscriberemail: 'email', subscriber: 'email',
    status: 'status', subscriptionstatus: 'status', subscriberstatus: 'status',
    subscribedat: 'subscribedAt', createdat: 'subscribedAt', signupdate: 'subscribedAt',
    emailsreceived: 'emailsReceived', totalemailsreceived: 'emailsReceived',
    openrate: 'openRate', uniqueopenrate: 'openRate', clickrate: 'clickRate', ctr: 'clickRate',
  };
  const mapped = headers.map((header) => aliases[header.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? header);
  if (!mapped.includes('email') || new Set(mapped).size !== mapped.length) throw new CliError('Die CSV-Datei benötigt eine eindeutige email-Spalte.', 'invalid_csv');
  return records.filter((record) => record.some(Boolean)).map((record, index) => {
    if (record.length !== headers.length) throw new CliError(`CSV-Zeile ${index + 2} hat eine falsche Spaltenanzahl.`, 'invalid_csv');
    const values = Object.fromEntries(mapped.map((header, column) => [header, record[column]!]));
    const email = values.email;
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new CliError(`CSV-Zeile ${index + 2} enthält keine gültige E-Mail-Adresse.`, 'invalid_csv');
    }
    const result: Record<string, unknown> = Object.fromEntries(Object.entries(values).filter(([key]) => ['email', 'status', 'subscribedAt', 'emailsReceived', 'openRate', 'clickRate'].includes(key)));
    result.status = values.status || 'active';
    if (!['active', 'dormant', 'unsubscribed', 'bounced', 'complained'].includes(String(result.status))) {
      throw new CliError(`CSV-Zeile ${index + 2} enthält einen ungültigen Status.`, 'invalid_csv');
    }
    for (const key of ['emailsReceived', 'openRate', 'clickRate']) {
      const value = values[key];
      if (value === undefined || value === '') { delete result[key]; continue; }
      const number = Number(value.replace(/%$/, ''));
      if (!Number.isFinite(number) || number < 0 || (key === 'emailsReceived' && !Number.isSafeInteger(number))) {
        throw new CliError(`CSV-Zeile ${index + 2} enthält keinen gültigen Wert für ${key}.`, 'invalid_csv');
      }
      const rate = value.endsWith('%') ? number / 100 : number;
      if (key !== 'emailsReceived' && rate > 1) throw new CliError(`CSV-Zeile ${index + 2} benötigt für ${key} einen Wert von 0 bis 1 oder einen Prozentwert.`, 'invalid_csv');
      result[key] = key === 'emailsReceived' ? number : rate;
    }
    if (values.subscribedAt) {
      isoDate(values.subscribedAt, `subscribedAt in CSV-Zeile ${index + 2}`);
    } else delete result.subscribedAt;
    return result;
  });
}

export function importRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) throw new CliError('Der Import benötigt mindestens einen Eintrag in rows.');
  return value.map((value, index) => {
    const row = object(value, 'Ein Import-Eintrag');
    if (Object.keys(row).some((key) => !['email', 'status', 'subscribedAt', 'emailsReceived', 'openRate', 'clickRate'].includes(key))) throw new CliError(`Import-Eintrag ${index + 1} enthält unbekannte Felder.`);
    if (typeof row.email !== 'string' || row.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) throw new CliError(`Import-Eintrag ${index + 1} enthält keine gültige E-Mail-Adresse.`);
    if (row.status !== undefined && !['active', 'dormant', 'unsubscribed', 'bounced', 'complained'].includes(String(row.status))) throw new CliError(`Import-Eintrag ${index + 1} enthält einen ungültigen Status.`);
    if (row.subscribedAt !== undefined) {
      if (typeof row.subscribedAt !== 'string') throw new CliError('subscribedAt muss ein ISO-8601-Zeitpunkt sein.');
      isoDate(row.subscribedAt, 'subscribedAt');
    }
    if (row.emailsReceived !== undefined && (!Number.isSafeInteger(row.emailsReceived) || Number(row.emailsReceived) < 0 || Number(row.emailsReceived) > 1_000_000)) throw new CliError('emailsReceived muss eine ganze Zahl von 0 bis 1000000 sein.');
    for (const key of ['openRate', 'clickRate']) if (row[key] !== undefined && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || Number(row[key]) < 0 || Number(row[key]) > 1)) throw new CliError(`${key} muss eine Zahl von 0 bis 1 sein.`);
    return row;
  });
}

/** Quote every value. Formula protection is the default for spreadsheet users. */
export function encodeCsv(rows: readonly Record<string, unknown>[], raw = false): string {
  const columns = ['_id', 'newsletterId', 'email', 'status', 'source', 'subscribedAt', 'unsubscribedAt', 'emailsReceived', 'openRate', 'clickRate'];
  const escaped = (value: unknown): string => {
    let text = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (!raw && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return `${columns.map(escaped).join(',')}\r\n${rows.map((row) => {
    const imported = row.imported && typeof row.imported === 'object' ? row.imported as Record<string, unknown> : {};
    return columns.map((column) => escaped(row[column] ?? imported[column])).join(',');
  }).join('\r\n')}${rows.length ? '\r\n' : ''}`;
}
