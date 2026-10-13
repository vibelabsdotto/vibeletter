export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 'usage_error',
    readonly status = 0,
    readonly details: unknown = undefined,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

const resolvedSecrets = new Set<string>();

/** Remember credentials for errors only, never for successful key output. */
export function rememberSecret(secret: string | undefined): void {
  if (secret) resolvedSecrets.add(secret);
}

export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string') {
    let text = value.replace(/vl_[A-Za-z0-9_-]+/g, '[REDACTED]')
      .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    for (const secret of secrets) if (secret) text = text.split(secret).join('[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(redact(key, secrets)),
      /^(token|key|apiKey|authorization|password|secret)$/i.test(key) && item
        ? '[REDACTED]' : redact(item, secrets),
    ]));
  }
  return value;
}

export function errorRecord(error: unknown, secrets: readonly string[] = []): {
  error: { code: string; message: string; status?: number; details?: unknown };
} {
  secrets = [...resolvedSecrets, ...secrets];
  const failure = error instanceof CliError ? error : new CliError(
    error instanceof Error ? error.message : 'Unbekannter Fehler.', 'internal_error',
  );
  return { error: {
    code: String(redact(failure.code, secrets)),
    message: String(redact(failure.message, secrets)),
    ...(failure.status ? { status: failure.status } : {}),
    ...(failure.details !== undefined ? { details: redact(failure.details, secrets) } : {}),
  } };
}

export function object(value: unknown, label = 'JSON'): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliError(`${label} muss ein JSON-Objekt sein.`);
  }
  return value as Record<string, unknown>;
}
