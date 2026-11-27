export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogData = Record<string, unknown>;

export interface Logger {
  debug(event: string, data?: LogData): void;
  info(event: string, data?: LogData): void;
  warn(event: string, data?: LogData): void;
  error(event: string, data?: LogData): void;
  child(base: LogData): Logger;
}

/** Anchored where a loose match would hide an operational field (`unknownKey`, `cooldownKey`, `ownKey` counts, `pinSetAt`). */
const SENSITIVE_KEY =
  /(authorization|cookie|token|secret|password|passphrase|private|credential|signature|csrf|api[-_]?key|session|bearer|email|personalization|userinfo|pushtoken|push_token|auth_token|download|scan[-_]?code|barcode|pair(?:ing)?[-_]?code$|[a-zA-Z]hmac[-_]?key$|[a-zA-Z]private[-_]?key$|[a-zA-Z]secret$|(?:^|[^a-zA-Z])(?:file|meta|aes|hmac)[-_]?keys?(?![a-z])|[a-z](?:File|Meta|Aes|Hmac)Keys?$|^keys$|key[-_]?material)|^pairing$/i;

/** Staff and unlock PINs (`pin`, `newPIN`, `staffPins`, `pinHash`, `STAFF_PIN`). Kept apart so `pinSetAt`, `pinOnly`, `pinMacVersion`, `staffPinId`, `shipping` and `mapping` stay readable. */
const PIN_KEY =
  /(?:^|[^a-zA-Z])[pP]in(?:[-_]?[hH]ash|[-_]?[cC]ode|s)?$|[a-z]Pin(?:Hash|Code|s)?$|(?:^|_)PINS?(?:_HASH)?$|[a-z]PINS?$/;

/** Capability URLs: /p/, /b/, /d/, /j/, /t/, /w/ and /preview/ values, `?t=`, `?sig=`, `?p=`, `?m=` and `#pair=` values, ApplePass/Bearer headers, API keys (`wlt_`, `pb_`, `pbp_`, `pbo_`), scanner tokens (`wls_`), try tokens (`pbtry_`), webhook secrets (`whsec_`), JWTs, PEM blocks. Shared with the developer request log. */
export const VALUE_PATTERNS: [RegExp, string][] = [
  [/(\/(?:preview|p|b|d|j|t|w|w\/i)\/)[A-Za-z0-9_.~-]{12,}/g, '$1[redacted]'],
  [/([?&](?:t|token|code|key|state|sig|exp|p|m)=)[^&\s"]+/gi, '$1[redacted]'],
  [/#pair=[^&\s"]+/g, '#pair=[redacted]'],
  [/(ApplePass|Bearer)\s+[A-Za-z0-9._~+/=-]+/g, '$1 [redacted]'],
  [/(wlt|wls|pbp|pbo)_[A-Za-z0-9_-]+/g, '$1_[redacted]'],
  [/pbtry_[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, 'pbtry_[redacted]'],
  [/pb_(?:live|test)_[A-Za-z0-9_-]+/g, 'pb_[redacted]'],
  [/whsec_[\w-]+/g, 'whsec_[redacted]'],
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted jwt]'],
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

const STACK_FRAMES = 8;
const CAUSE_DEPTH = 2;

export interface RedactOptions {
  /** Include the first frames of an Error's stack (error level only). */
  stack?: boolean;
}

function serializeError(
  error: Error,
  options: RedactOptions,
  causeDepth: number,
): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  const out: Record<string, unknown> = { name: error.name, message: redactString(error.message) };
  if (typeof code === 'string' || typeof code === 'number') out.code = code;
  if (error.cause !== undefined && causeDepth < CAUSE_DEPTH) {
    out.cause =
      error.cause instanceof Error
        ? serializeError(error.cause, { ...options, stack: false }, causeDepth + 1)
        : redact(error.cause, 0, options);
  }
  if (options.stack && error.stack) {
    out.stack = redactString(
      error.stack
        .split('\n')
        .slice(0, STACK_FRAMES + 1)
        .join('\n'),
    );
  }
  return out;
}

export function redact(value: unknown, depth = 0, options: RedactOptions = {}): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (value instanceof Error) return serializeError(value, options, 0);
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => redact(item, depth + 1, options));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] =
      SENSITIVE_KEY.test(key) || PIN_KEY.test(key)
        ? '[redacted]'
        : redact(item, depth + 1, options);
  }
  return out;
}

/** The `code` of an Error passed as `data.error`, so call sites need not repeat it. */
function codeOf(data: LogData | undefined): string | number | undefined {
  const code = (data?.error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
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
    const code = data?.code === undefined ? codeOf(data) : undefined;
    const line = JSON.stringify(
      redact(
        { level, event, at: now(), ...base, ...(code === undefined ? {} : { code }), ...data },
        0,
        { stack: level === 'error' },
      ),
    );
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
