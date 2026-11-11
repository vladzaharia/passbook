import { first, type SqlValue } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { tenantPassAuthorityParams, tenantPassAuthoritySql } from '../passes/repo-authority.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';

/** Ephemeral session-secret SQL values are bound directly, never serialized into JSON. */
export type EventAuthority = TenantPassWrite & {
  csrfFence: { sql: string; params: readonly SqlValue[] };
  credentialEnv: ServiceContext['env'];
};

/** Bootstrap only while this exact tenant session and optional target still match. */
export function eventKeysetGuard(
  authority: EventAuthority,
  now: number,
  eventId?: string,
): {
  sql: string;
  params: SqlValue[];
} {
  const access = `${tenantPassAuthoritySql(authority)} AND (${authority.csrfFence.sql})`;
  const accessParams = [
    ...tenantPassAuthorityParams(authority, now),
    ...authority.csrfFence.params,
  ];
  if (eventId === undefined) return { sql: access, params: accessParams };
  return {
    sql: `${access} AND EXISTS (SELECT 1 FROM scan_events target
      WHERE target.id=? AND target.org_id=? AND target.mode=?)`,
    params: [...accessParams, eventId, authority.orgId, authority.mode],
  };
}

/** Session and secret are checked together before classifying a missing target. */
export async function eventSessionAuthorityValid(
  db: D1Database,
  authority: EventAuthority,
  now: number,
): Promise<boolean> {
  const guard = eventKeysetGuard(authority, now);
  return !!(await first(db, `SELECT 1 WHERE ${guard.sql}`, guard.params));
}

/** Check the original commitment and the captured session together, even for an empty result. */
export async function eventReadAuthorityState(
  db: D1Database,
  authority: EventAuthority,
  now: number,
  credentialKeysetCommitment: string,
): Promise<{ authority: boolean; keyset: boolean }> {
  const guard = eventKeysetGuard(authority, now);
  const row = await first<{ authority: number; keyset: number }>(
    db,
    `SELECT (${guard.sql}) AS authority, ${credentialRefKeysetSql} AS keyset`,
    [...guard.params, credentialKeysetCommitment],
  );
  return { authority: row?.authority === 1, keyset: row?.keyset === 1 };
}
