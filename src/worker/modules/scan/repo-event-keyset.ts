import { first, type SqlValue } from '../../platform/db.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';

/** Ephemeral session-secret SQL values are bound directly, never serialized into JSON. */
export type EventAuthority = TenantPassWrite & {
  csrfFence: { sql: string; params: readonly SqlValue[] };
};

/** Session and secret are checked together before classifying a missing target. */
export async function eventSessionAuthorityValid(
  db: D1Database,
  authority: EventAuthority,
  now: number,
): Promise<boolean> {
  const sql = `${tenantPassAuthoritySql(authority)} AND (${authority.csrfFence.sql})`;
  const params = [...tenantPassAuthorityParams(authority, now), ...authority.csrfFence.params];
  return !!(await first(db, `SELECT 1 WHERE ${sql}`, params));
}
