const SENSITIVE_KEY =
  /secret|token|password|passphrase|private|credential|authorization|cookie|personalization|api[_-]?key|pkcs12|(^|[._-])key([._-]|$)/i;
const MAX_DEPTH = 6;
const MAX_STRING = 500;
const MAX_BYTES = 8000;
export const REDACTED = '[redacted]';

type Obj = Record<string, unknown>;

/** Copy of a value with sensitive keys masked, long strings cut and depth bounded. */
export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string')
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1));
  const out: Obj = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(inner, depth + 1);
  }
  return out;
}

/** Redacted detail that fits one audit row. */
export function redactDetail(detail: Obj): Obj {
  const safe = redact(detail) as Obj;
  return JSON.stringify(safe).length > MAX_BYTES ? { truncated: true } : safe;
}

/** `{ key: { from, to } }` for the keys whose values differ. Sensitive keys are masked. */
export function diffFields(before: Obj, after: Obj, keys?: readonly string[]): Obj {
  const out: Obj = {};
  for (const key of keys ?? new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    out[key] = SENSITIVE_KEY.test(key)
      ? REDACTED
      : { from: redact(before[key] ?? null), to: redact(after[key] ?? null) };
  }
  return out;
}
