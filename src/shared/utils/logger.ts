export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

interface LogData {
  message: string;
  [key: string]: unknown;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

const SENSITIVE_KEYS = [
  'password',
  'token',
  'secret',
  'key',
  'authorization',
  'access_token',
  'refresh_token',
];

let currentLevel: LogLevel = 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEYS.some((sensitive) => normalized.includes(sensitive));
}

function sanitizeValue(value: unknown, key: string, seen: WeakSet<object>): unknown {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, key, seen));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeValue(entryValue, entryKey, seen),
    ]),
  );
}

function formatLog(level: LogLevel, logger: string, data: LogData): string {
  const { message, ...fields } = data;
  const sanitized = sanitizeValue(fields, '', new WeakSet());
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    logger,
    message,
    ...(sanitized && typeof sanitized === 'object' ? sanitized : {}),
  });
}

export const sharedLogger = {
  setLevel(level: LogLevel): void {
    currentLevel = level;
  },

  debug(logger: string, data: LogData): void {
    if (shouldLog('debug')) console.debug(formatLog('debug', logger, data));
  },

  info(logger: string, data: LogData): void {
    if (shouldLog('info')) console.info(formatLog('info', logger, data));
  },

  warning(logger: string, data: LogData): void {
    if (shouldLog('warning')) console.warn(formatLog('warning', logger, data));
  },

  error(logger: string, data: LogData): void {
    if (shouldLog('error')) console.error(formatLog('error', logger, data));
  },
};
