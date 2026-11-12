import { type SqlValue, stmt } from '../../platform/db.ts';
import { credentialRefKeysetSql } from '../passes/repo-credential-keyset.ts';

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
  if (refs.length === 0)
    return { sql: credentialRefKeysetSql, params: [credentialKeysetCommitment] };
  return {
    sql: `(NOT EXISTS (SELECT 1 FROM pass_credential_tombstones tombstone
      WHERE tombstone.org_id=${scope.orgIdSql} AND tombstone.mode=${scope.modeSql}
        AND tombstone.credential_hash IN (SELECT value FROM json_each(?/* scan-ephemeral-credential-refs */))) AND ${credentialRefKeysetSql})`,
    params: [JSON.stringify(refs), credentialKeysetCommitment],
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
    `SELECT 1 WHERE ${predicate.sql}`,
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
