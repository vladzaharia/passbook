import type { z } from 'zod';
import type { CreateApiKeySchema } from '../../../shared/contracts/index.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import { parseCidr } from '../../platform/ip-allow.ts';
import type { ApiKeyRow } from './repo-row.ts';
import type { Resources } from './service-dto.ts';

type Input = z.infer<typeof CreateApiKeySchema>;

/** What a child holds beyond its scopes: each dimension is its parent's, or narrower. */
export interface ChildSettings {
  expiresAt: number | null;
  ipAllow: string[];
  templateIds: string[];
  passStyles: string[];
}

const wider = (dimension: string) =>
  new ForbiddenError(
    `A child key cannot be wider than its parent in ${dimension}.`,
    'API_KEY_CHILD_WIDER',
  );

/** `child` lies inside `parent` (same family, longer or equal prefix). */
function within(child: string, parent: string): boolean {
  const c = parseCidr(child);
  const p = parseCidr(parent);
  if (!c || !p || c.v !== p.v || c.bits < p.bits) return false;
  const width = c.v === 4 ? 32 : 128;
  const shift = BigInt(width - p.bits);
  return c.n >> shift === p.n >> shift;
}

/** The values a child names for a limited dimension: its own, inside the parent's, or the parent's when it names none. */
function narrow(
  parent: readonly string[],
  asked: readonly string[] | undefined,
  dimension: string,
) {
  if (parent.length === 0) return [...new Set(asked ?? [])];
  const own = asked?.length ? [...new Set(asked)] : [...parent];
  if (own.some((value) => !parent.includes(value))) throw wider(dimension);
  return own;
}

/**
 * The expiry, addresses, templates and styles of a child, each no wider than the parent's. Omitted means the
 * parent's. Scopes, org, mode and kind are held elsewhere (`delegableScopes`, the mint route, the insert trigger).
 */
export function attenuate(parent: ApiKeyRow, held: Resources, input: Input): ChildSettings {
  // Omitted means the parent's expiry; naming none (null) under a parent that expires is wider.
  let expiresAt = input.expiresAt ?? null;
  if (parent.expires_at !== null) {
    expiresAt = input.expiresAt === undefined ? parent.expires_at : input.expiresAt;
    if (expiresAt === null || expiresAt > parent.expires_at) throw wider('expiry');
  }
  const parentIps: string[] = parent.ip_allow ? JSON.parse(parent.ip_allow) : [];
  const askedIps = input.ipAllow?.map((c) => c.trim());
  const ipAllow =
    parentIps.length === 0 ? (askedIps ?? []) : askedIps?.length ? askedIps : parentIps;
  if (parentIps.length > 0 && !ipAllow.every((c) => parentIps.some((p) => within(c, p))))
    throw wider('allowed addresses');
  return {
    expiresAt,
    ipAllow,
    templateIds: narrow(held.templateIds, input.templateIds, 'templates'),
    passStyles: narrow(held.passStyles, input.passStyles, 'pass styles'),
  };
}
