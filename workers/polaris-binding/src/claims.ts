import { type ClaimChange, type ClaimValue, IdpError } from './types.ts';

const refuse = (message: string): never => {
  throw new IdpError('IDP_REFUSED', message);
};

/** Keys Polaris ID refuses, plus `picture`, which it overwrites. */
const RESERVED = new Set([
  'given_name',
  'family_name',
  'name',
  'email',
  'email_verified',
  'preferred_username',
  'display_name',
  'groups',
  'type',
  'sub',
  'iss',
  'aud',
  'exp',
  'iat',
  'auth_time',
  'nonce',
  'acr',
  'amr',
  'azp',
  'client_id',
  'nbf',
  'jti',
  'picture',
]);
const NAMESPACE = /^passbook_[a-z0-9_]{1,48}$/;
const LISTED = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const MAX_VALUE = 2048;
const MAX_KEYS = 20;
const MAX_BYTES = 8192;
const MAX_DEPTH = 5;

/** An owner-listed key must be exact, not reserved, and outside the namespace. */
export const listedKeyOk = (key: string): boolean =>
  LISTED.test(key) && !RESERVED.has(key) && !key.startsWith('passbook_');

/** `ns` keys are free-form under passbook_; `listed` keys are exact entries of CLAIM_KEYS. */
export function keyKind(key: string, claimKeys: string[]): 'ns' | 'listed' | null {
  if (NAMESPACE.test(key) && !RESERVED.has(key)) return 'ns';
  return claimKeys.includes(key) && listedKeyOk(key) ? 'listed' : null;
}

const depth = (v: unknown): number =>
  v && typeof v === 'object'
    ? 1 + Math.max(0, ...Object.values(v as object).map((x) => depth(x)))
    : 0;

/**
 * The stored form. Text that would parse as JSON is stored JSON-quoted so it stays a string in tokens;
 * numbers and booleans are stored as their JSON; JSON values as their JSON text.
 */
export function encode(v: ClaimValue): string {
  let out: string;
  switch (v?.type) {
    case 'text': {
      if (typeof v.value !== 'string') return refuse('Invalid claim value.');
      try {
        JSON.parse(v.value);
        out = JSON.stringify(v.value);
      } catch {
        out = v.value;
      }
      break;
    }
    case 'number':
      if (typeof v.value !== 'number' || !Number.isFinite(v.value))
        return refuse('Invalid claim value.');
      out = JSON.stringify(v.value);
      break;
    case 'boolean':
      if (typeof v.value !== 'boolean') return refuse('Invalid claim value.');
      out = JSON.stringify(v.value);
      break;
    case 'json':
      if (!v.value || typeof v.value !== 'object' || depth(v.value) > MAX_DEPTH)
        return refuse('Invalid claim value.');
      out = JSON.stringify(v.value);
      break;
    default:
      return refuse('Invalid claim type.');
  }
  if (out.length === 0 || out.length > MAX_VALUE)
    return refuse('Claim value is empty or too long.');
  return out;
}

export function decode(stored: string): ClaimValue {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed === 'string') return { type: 'text', value: parsed };
    if (typeof parsed === 'number') return { type: 'number', value: parsed };
    if (typeof parsed === 'boolean') return { type: 'boolean', value: parsed };
    return { type: 'json', value: parsed };
  } catch {
    return { type: 'text', value: stored };
  }
}

export interface Claim {
  key: string;
  value: string;
}

/** The claims of a user or group DTO. A missing or malformed list is never "no claims". */
export function parseClaims(body: unknown): Claim[] {
  const list = (body as { customClaims?: unknown } | null)?.customClaims;
  if (!Array.isArray(list))
    throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned unexpected claims.');
  return list.map((c) => {
    const k = (c as { key?: unknown } | null)?.key;
    const v = (c as { value?: unknown } | null)?.value;
    if (typeof k !== 'string' || typeof v !== 'string')
      throw new IdpError('IDP_UPSTREAM', 'Polaris ID returned unexpected claims.');
    return { key: k, value: v };
  });
}

/** Validates the changes against the key rules and the size limits. Any refusal refuses all. */
export function assertChanges(
  value: unknown,
  claimKeys: string[],
  allowListed: boolean,
): Record<string, ClaimChange> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('Invalid claims.');
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.length > MAX_KEYS) return refuse('Invalid claims.');
  for (const [key, change] of entries) {
    const kind = keyKind(key, claimKeys);
    if (!kind || (kind === 'listed' && !allowListed)) return refuse('Claim key not allowed.');
    if (change !== null) encode(change as ClaimValue);
  }
  return value as Record<string, ClaimChange>;
}

/** The current set with the changes applied. Every other key and value is copied unchanged and in place. */
export function merge(
  current: Claim[],
  changes: Record<string, ClaimChange>,
  claimKeys: string[],
): { next: Claim[]; set: string[]; removed: string[] } {
  const next: Claim[] = [];
  const set: string[] = [];
  const removed: string[] = [];
  const done = new Set<string>();
  for (const c of current) {
    if (!(c.key in changes)) {
      next.push(c);
      continue;
    }
    done.add(c.key);
    const change = changes[c.key];
    if (change === null || change === undefined) removed.push(c.key);
    else {
      next.push({ key: c.key, value: encode(change) });
      set.push(c.key);
    }
  }
  for (const [key, change] of Object.entries(changes))
    if (!done.has(key) && change) {
      next.push({ key, value: encode(change) });
      set.push(key);
    }
  const managed = next.filter((c) => keyKind(c.key, claimKeys));
  const bytes = managed.reduce((n, c) => n + c.key.length + c.value.length, 0);
  if (managed.length > MAX_KEYS || bytes > MAX_BYTES) refuse('Too many claims for one owner.');
  return { next, set, removed };
}

/** Equal sets, order aside. */
export const sameClaims = (a: Claim[], b: Claim[]): boolean =>
  a.length === b.length && a.every((x) => b.some((y) => y.key === x.key && y.value === x.value));
