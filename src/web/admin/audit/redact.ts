const SENSITIVE =
  /(secret|token|password|passphrase|private|authorization|cookie|credential|pem|pkcs12|p12|^key$|apikey|api_key)/i;

export const REDACTED = '[redacted]';

/** Defence in depth: the server redacts, the UI never shows a secret-looking key's value. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? REDACTED : redact(v)]),
    );
  }
  return value;
}

export interface DetailView {
  kind: 'diff' | 'json' | 'none';
  before?: string;
  after?: string;
  value?: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `{ before, after }` details render as a diff, with any other recorded fields kept as context. */
export function describeDetail(detail: unknown): DetailView {
  if (detail === null || detail === undefined) return { kind: 'none' };
  const safe = redact(detail);
  if (isObject(safe) && ('before' in safe || 'after' in safe)) {
    const { before, after, ...context } = safe;
    const pretty = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2));
    return {
      kind: 'diff',
      before: pretty(before),
      after: pretty(after),
      ...(Object.keys(context).length ? { value: context } : {}),
    };
  }
  return { kind: 'json', value: safe };
}
