import type { LogLevel } from './config';

export type LogFields = Record<string, unknown>;

/**
 * Structured JSON logs on stdout. Workers Logs and most log shippers index each field.
 * MCP's client-facing logging is deprecated in protocol 2026-07-28, so logs stay server-side.
 */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warning(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** A logger that adds `fields` to every entry. */
  child(fields: LogFields): Logger;
}

const SEVERITY: Record<LogLevel, number> = { debug: 0, info: 1, warning: 2, error: 3 };

const WRITE: Record<LogLevel, (line: string) => void> = {
  debug: (line) => console.debug(line),
  info: (line) => console.info(line),
  warning: (line) => console.warn(line),
  error: (line) => console.error(line),
};

export function createLogger(level: LogLevel, context: LogFields = {}): Logger {
  const log = (entryLevel: LogLevel, message: string, fields: LogFields = {}) => {
    if (SEVERITY[entryLevel] < SEVERITY[level]) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      message: redactText(message),
      ...(sanitize({ ...context, ...fields }, new WeakSet()) as LogFields),
    };
    WRITE[entryLevel](JSON.stringify(entry));
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warning: (message, fields) => log('warning', message, fields),
    error: (message, fields) => log('error', message, fields),
    child: (fields) => createLogger(level, { ...context, ...fields }),
  };
}

const SECRET_WORDS = new Set([
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'passwd',
  'password',
  'pwd',
  'secret',
  'token',
]);

/** Words that make a following `key` a secret: `apiKey`, `x-api-key`, `privateKey`. */
const KEY_QUALIFIERS = new Set(['access', 'api', 'encryption', 'private', 'secret', 'signing']);

/**
 * Field names that hold secrets: `accessToken`, `client_secret`, `x-api-key`, `Set-Cookie`,
 * `privateKey`. A plain `key` (a cache key, a map key) is not one; neither is `tokenizer`.
 */
function isSecretKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some(
    (word, index) =>
      SECRET_WORDS.has(word) ||
      (word === 'key' && KEY_QUALIFIERS.has(words[index - 1] ?? '')) ||
      word === 'apikey',
  );
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [REDACTED]'],
  [/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[REDACTED_JWT]'],
  [/(\/\/)[^/@\s:]+:[^/@\s]+@/g, '$1[REDACTED]@'],
  [
    /(^|[?&])((?:access_token|api_key|apikey|client_secret|code|key|password|token)=)[^&#\s]+/gi,
    '$1$2[REDACTED]',
  ],
  [/(^|\s)((?:access_token|api_key|apikey|client_secret|password|token)=)\S+/gi, '$1$2[REDACTED]'],
];

/**
 * Secrets also hide in values: error messages, URLs and headers copied into a string. These
 * patterns catch the common shapes (bearer and basic credentials, JWTs, credentials in URLs
 * and query strings), not every secret a string could contain.
 */
function redactText(text: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    text,
  );
}

function sanitize(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return sanitize(
      {
        name: value.name,
        message: value.message,
        ...(value.stack && { stack: value.stack }),
        ...(value.cause !== undefined && { cause: value.cause }),
      },
      seen,
    );
  }
  if (value instanceof URL) return redactText(value.href);
  if (Array.isArray(value)) return value.map((entry) => sanitize(entry, seen));

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSecretKey(key) ? '[REDACTED]' : sanitize(entry, seen),
    ]),
  );
}
