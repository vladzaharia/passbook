export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogData = Record<string, unknown>;

export interface Logger {
  debug(event: string, data?: LogData): void;
  info(event: string, data?: LogData): void;
  warn(event: string, data?: LogData): void;
  error(event: string, data?: LogData): void;
  child(base: LogData): Logger;
}

const SENSITIVE_KEY =
  /(authorization|cookie|token|secret|password|passphrase|private|credential|signature|csrf|api[-_]?key|session|bearer|email|personalization|userinfo|pushtoken|push_token|auth_token|download)/i;

/** Capability URLs: /p/<token>, ?t=<token>, ApplePass/Bearer headers, wlt_ keys, PEM blocks. */
const VALUE_PATTERNS: [RegExp, string][] = [
  [/(\/p\/)[A-Za-z0-9_-]{16,}/g, '$1[redacted]'],
  [/([?&](?:t|token|code|key|state)=)[^&\s]+/gi, '$1[redacted]'],
  [/(ApplePass|Bearer)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [redacted]'],
  [/wlt_[A-Za-z0-9_-]+/g, 'wlt_[redacted]'],
  [/-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g, '[redacted pem]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted email]'],
];

const MAX_DEPTH = 6;
const MAX_STRING = 2000;

export function redactString(value: string): string {
  let out = value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, depth + 1);
  }
  return out;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogSink = (line: string, level: LogLevel) => void;

const consoleSink: LogSink = (line, level) => {
  // biome-ignore lint/suspicious/noConsole: the single place logs leave the process
  console[level === 'debug' ? 'log' : level](line);
};

export function createLogger(
  base: LogData = {},
  options: { level?: LogLevel; sink?: LogSink; now?: () => number } = {},
): Logger {
  const min = ORDER[options.level ?? 'info'];
  const sink = options.sink ?? consoleSink;
  const now = options.now ?? Date.now;
  const emit = (level: LogLevel, event: string, data?: LogData) => {
    if (ORDER[level] < min) return;
    const line = JSON.stringify(redact({ level, event, at: now(), ...base, ...data }));
    sink(line, level);
  };
  return {
    debug: (event, data) => emit('debug', event, data),
    info: (event, data) => emit('info', event, data),
    warn: (event, data) => emit('warn', event, data),
    error: (event, data) => emit('error', event, data),
    child: (extra) => createLogger({ ...base, ...extra }, options),
  };
}

export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
