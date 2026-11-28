import { type SqlValue, stmt } from '../../platform/db.ts';
import { credentialRefKeysetMatch } from '../passes/repo-credential-keyset.ts';
import { RACE_TOMBSTONE_CLEAR } from './race-tags.ts';

type Scope = { orgIdSql: string; modeSql: string };
type Predicate = { sql: string; params: SqlValue[] };

export function validCredentialTombstoneRefs(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    value.every((ref) => typeof ref === 'string' && /^[0-9a-f]{64}$/.test(ref))
  );
}
export function validCredentialKeysetCommitment(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

/** Keyed refs are compared across all credential kinds for the same tenant and mode. */
export function noCredentialTombstonesSql(
  refs: readonly string[] | null | undefined,
  scope: Scope,
  credentialKeysetCommitment: string | null | undefined,
): Predicate {
  if (
    !validCredentialTombstoneRefs(refs) ||
    !validCredentialKeysetCommitment(credentialKeysetCommitment)
  )
    return { sql: '0', params: [] };
  if (refs.length === 0) return credentialRefKeysetMatch(credentialKeysetCommitment);
  const keyset = credentialRefKeysetMatch(credentialKeysetCommitment);
  return {
    sql: `(NOT EXISTS (SELECT 1 FROM pass_credential_tombstones tombstone
      WHERE tombstone.org_id=${scope.orgIdSql} AND tombstone.mode=${scope.modeSql}
        AND tombstone.credential_hash IN (SELECT value FROM json_each(?))) AND ${keyset.sql})`,
    params: [JSON.stringify(refs), ...keyset.params],
  };
}

/** Hex characters of a keyed ref a stateless grant carries (`asset-grant-mint.ts`). */
export const CREDENTIAL_REF_PREFIX = 16;

/**
 * The same check for refs known only by their leading hex digits: each prefix is a range of the
 * (org, mode, hash) index, so a retired ref always matches and a clash can only deny.
 */
export function noCredentialTombstonePrefixesSql(
  prefixes: readonly string[],
  scope: Scope,
  credentialKeysetCommitment: string | null | undefined,
): Predicate {
  if (
    prefixes.length > 3 ||
    !prefixes.every((prefix) => new RegExp(`^[0-9a-f]{${CREDENTIAL_REF_PREFIX}}$`).test(prefix)) ||
    !validCredentialKeysetCommitment(credentialKeysetCommitment)
  )
    return { sql: '0', params: [] };
  if (prefixes.length === 0) return credentialRefKeysetMatch(credentialKeysetCommitment);
  const rest = 64 - CREDENTIAL_REF_PREFIX;
  const keyset = credentialRefKeysetMatch(credentialKeysetCommitment);
  return {
    sql: `(NOT EXISTS (SELECT 1 FROM pass_credential_tombstones tombstone
      WHERE tombstone.org_id=${scope.orgIdSql} AND tombstone.mode=${scope.modeSql}
        AND (${prefixes.map(() => 'tombstone.credential_hash BETWEEN ? AND ?').join(' OR ')})) AND ${keyset.sql})`,
    params: [
      ...prefixes.flatMap((prefix) => [prefix + '0'.repeat(rest), prefix + 'f'.repeat(rest)]),
      ...keyset.params,
    ],
  };
}

/** A statement suitable for the same D1 batch as candidate lookups. */
export function credentialTombstonesClearStmt(
  db: D1Database,
  orgId: string,
  mode: 'live' | 'test',
  refs: readonly string[],
  credentialKeysetCommitment: string | null | undefined,
): D1PreparedStatement {
  const predicate = noCredentialTombstonesSql(
    refs,
    { orgIdSql: '?', modeSql: '?' },
    credentialKeysetCommitment,
  );
  if (predicate.sql === '0') return stmt(db, 'SELECT 1 WHERE 0');
  return stmt(
    db,
    `${RACE_TOMBSTONE_CLEAR} SELECT 1 WHERE ${predicate.sql}`,
    refs.length === 0 ? predicate.params : [orgId, mode, ...predicate.params],
  );
}

/** Used before replay/cross-mode disclosure; writes repeat the same predicate atomically. */
export async function credentialTombstonesClear(
  db: D1Database,
  orgId: string,
  mode: 'live' | 'test',
  refs: readonly string[],
  credentialKeysetCommitment: string | null | undefined,
): Promise<boolean> {
  if (
    !validCredentialTombstoneRefs(refs) ||
    !validCredentialKeysetCommitment(credentialKeysetCommitment)
  )
    return false;
  return (
    (await credentialTombstonesClearStmt(
      db,
      orgId,
      mode,
      refs,
      credentialKeysetCommitment,
    ).first()) !== null
  );
}
