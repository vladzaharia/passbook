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

// Audit rows may predate the write-time redactor. Do not publish contact data, capability
// links, or identifiers for users and other resources embedded in arbitrary legacy detail.
const READ_SENSITIVE_KEY =
  /email|e.?mail|url|uri|link|address|phone|contact|external.?ref|(?:^|[._-])id$|id$|secret|token|password|passphrase|private|credential|authorization|cookie|personalization|api[_-]?key|pkcs12|(^|[._-])key([._-]|$)/i;
// Conservatively match email-like text rather than duplicating the supported addr-spec grammar.
const SENSITIVE_VALUE =
  /[^\s@]+@[^\s@]+|(?:https?:\/\/|www\.)|(?:wlt|wls)_[A-Za-z0-9_-]+|(?:^|[^A-Za-z0-9_-])[A-Za-z0-9_-]{32,}(?:$|[^A-Za-z0-9_-])/i;
const TENANT_ENUM_FIELDS: Record<string, true> = {
  mode: true,
  kind: true,
  send: true,
  via: true,
  status: true,
  state: true,
  cause: true,
  health: true,
  method: true,
  role: true,
  deviceRole: true,
  surface: true,
};
const TENANT_ENUM_VALUES: Record<string, true> = {
  active: true,
  archived: true,
  cancelled: true,
  change: true,
  code: true,
  console: true,
  customer: true,
  degraded: true,
  deleted: true,
  desk: true,
  device: true,
  display: true,
  door: true,
  draft: true,
  email: true,
  event: true,
  failing: true,
  healthy: true,
  hybrid: true,
  live: true,
  manager: true,
  manual: true,
  message: true,
  monitor: true,
  now: true,
  oidc: true,
  partial: true,
  paused: true,
  poll: true,
  scan: true,
  scheduled: true,
  sending: true,
  sent: true,
  snapshot: true,
  suspended: true,
  templates: true,
  terminal: true,
  test: true,
  unknown: true,
  voided: true,
  webhook: true,
};
// Names the organization itself owns: shown to its members, still screened by SENSITIVE_VALUE.
const TENANT_TEXT_FIELDS: Record<string, true> = { name: true, slug: true, label: true };
const TENANT_DETAIL_KEYS: Record<string, true> = {
  accepts: true,
  action: true,
  adminSession: true,
  after: true,
  attempts: true,
  before: true,
  block: true,
  branding: true,
  bytes: true,
  cause: true,
  changed: true,
  changes: true,
  code: true,
  connectorType: true,
  count: true,
  daysRemaining: true,
  derived: true,
  detached: true,
  detachedEvent: true,
  deviceRole: true,
  email: true,
  errorCode: true,
  expiresAt: true,
  failures: true,
  fields: true,
  from: true,
  fromUserId: true,
  health: true,
  includeInPass: true,
  kind: true,
  label: true,
  method: true,
  mode: true,
  name: true,
  note: true,
  ok: true,
  patch: true,
  published: true,
  reason: true,
  reset: true,
  restored: true,
  role: true,
  rows: true,
  scanners: true,
  scheduled: true,
  send: true,
  slug: true,
  state: true,
  status: true,
  surface: true,
  to: true,
  truncated: true,
  userId: true,
  version: true,
  via: true,
};

/** A display label must never fall back to an email address or contain a capability. */
export function safeLabel(value: string | null): string | null {
  return value && !SENSITIVE_VALUE.test(value) ? value.slice(0, MAX_STRING) : null;
}

/**
 * Tenant details retain numeric/boolean metadata and known enum values, not arbitrary
 * strings that can contain another user's name, an external reference, or a secret.
 */
export function redactForRead(
  value: unknown,
  tenant: boolean,
  key = '',
  parent = '',
  depth = 0,
): unknown {
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value)) return REDACTED;
    if (tenant) {
      const field = key === 'from' || key === 'to' ? parent : key;
      if (Object.hasOwn(TENANT_TEXT_FIELDS, field))
        return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
      const isEnum =
        Object.hasOwn(TENANT_ENUM_FIELDS, key) ||
        ((key === 'from' || key === 'to') && Object.hasOwn(TENANT_ENUM_FIELDS, parent));
      if (!isEnum || !Object.hasOwn(TENANT_ENUM_VALUES, value)) return REDACTED;
    }
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => redactForRead(item, tenant, key, parent, depth + 1));
  const out: Obj = Object.create(null);
  for (const [innerKey, inner] of Object.entries(value)) {
    if (
      SENSITIVE_VALUE.test(innerKey) ||
      (tenant && !Object.hasOwn(TENANT_DETAIL_KEYS, innerKey))
    ) {
      out[REDACTED] = REDACTED;
      continue;
    }
    out[innerKey] = READ_SENSITIVE_KEY.test(innerKey)
      ? REDACTED
      : redactForRead(inner, tenant, innerKey, key, depth + 1);
  }
  return out;
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
