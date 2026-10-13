import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CliError, object } from './errors.js';

export const MAX_INPUT_BYTES = 8 * 1024 * 1024;
let consumedStdin = false;

export function assertSafePath(file: string): void {
  const absolute = path.resolve(file);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new CliError('Die Datei und ihre Verzeichnisse dürfen keine Symlinks sein.', 'unsafe_file');
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readSource(source: string, maxBytes = MAX_INPUT_BYTES, privateFile = false): Promise<Buffer> {
  if (source === '-') {
    if (privateFile && process.stdin.isTTY) throw new CliError('Die Token-Eingabe benötigt eine Pipe.');
    if (consumedStdin) throw new CliError('stdin kann pro Aufruf nur einmal gelesen werden.');
    consumedStdin = true;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += bytes.length;
      if (size > maxBytes) throw new CliError(`Die Eingabe darf höchstens ${maxBytes} Bytes enthalten.`, 'input_too_large');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  }
  let fd: number | undefined;
  try {
    if (privateFile) assertSafePath(source);
    const info = fs.lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new CliError('Die Eingabe muss eine reguläre Datei sein.', 'unsafe_file');
    if (privateFile && ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid()))) {
      throw new CliError('Die Token-Datei muss dir gehören und Dateirechte 0600 haben.', 'unsafe_file');
    }
    if (info.size > maxBytes) throw new CliError(`Die Eingabe darf höchstens ${maxBytes} Bytes enthalten.`, 'input_too_large');
    fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || info.dev !== opened.dev || info.ino !== opened.ino || opened.size > maxBytes || (privateFile && ((opened.mode & 0o077) !== 0 || (process.getuid && opened.uid !== process.getuid())))) {
      throw new CliError('Die Eingabedatei wurde während des Lesens geändert.', 'unsafe_file');
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count > maxBytes) throw new CliError(`Die Eingabe darf höchstens ${maxBytes} Bytes enthalten.`, 'input_too_large');
    return bytes.subarray(0, count);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Die Eingabedatei kann nicht gelesen werden: ${source}`, 'file_error');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function readJson(source: string): Promise<Record<string, unknown>> {
  const bytes = await readSource(source);
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { throw new CliError('Die Eingabe enthält ungültiges JSON.', 'invalid_json'); }
  return object(value);
}

/** Exercise the output directory before a once-visible credential is created. */
export function preflightPrivateOutput(file: string): void {
  const target = path.resolve(file);
  try {
    assertSafePath(target);
    try {
      if (!fs.lstatSync(target).isFile()) throw new CliError('Das Ziel muss eine reguläre Datei sein.', 'unsafe_file');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertSafePath(target);
    fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    const probe = path.join(dir, `.vibeletter-output-${randomUUID()}.tmp`);
    try { writePrivate(probe, ''); }
    finally { if (fs.existsSync(probe)) fs.unlinkSync(probe); }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Die Ausgabedatei kann nicht sicher geschrieben werden. Es wurde kein Schlüssel angelegt.', 'file_error');
  }
}

/** Same-directory rename, exclusive temporary file, fsync, and private permissions. */
export function writePrivate(file: string, content: string | Uint8Array): void {
  const target = path.resolve(file);
  assertSafePath(target);
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertSafePath(target);
  try {
    if (!fs.lstatSync(target).isFile()) throw new CliError('Das Ziel muss eine reguläre Datei sein.', 'unsafe_file');
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const temp = path.join(dir, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let renamed = false;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, target);
    renamed = true;
    const dirFd = fs.openSync(dir, fs.constants.O_RDONLY);
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!renamed && fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

export function output(value: unknown, compact = false): void {
  process.stdout.write(`${JSON.stringify(value, null, compact ? undefined : 2)}\n`);
}

export function integer(value: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!/^\d+$/.test(value)) throw new CliError('Der Wert muss eine ganze Zahl sein.');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new CliError(`Der Wert muss zwischen ${minimum} und ${maximum} liegen.`);
  }
  return result;
}

export function isoDate(value: string, label = 'Zeitpunkt'): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new CliError(`${label} muss ein ISO-8601-Zeitpunkt mit Sekunden und expliziter Zeitzone sein.`);
  }
  const day = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(Date.parse(value)) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) {
    throw new CliError(`${label} enthält kein gültiges Kalenderdatum.`);
  }
  return value;
}

export function boolean(value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new CliError('Der Wert muss true oder false sein.');
}
