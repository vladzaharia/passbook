import { batch, first, run, stmt } from '../../platform/db.ts';

/** SCIM receiver bearer tokens. Only the SHA-256 (hex) of a token is stored. */
export interface ScimTokenRow {
  id: string;
  state: 'pending' | 'active' | 'retired';
  token_sha256: string;
  created_at: number;
  activated_at: number | null;
  retired_at: number | null;
  last_auth_at: number | null;
  created_by: string;
}

const COLUMNS =
  'id, state, token_sha256, created_at, activated_at, retired_at, last_auth_at, created_by';

export const activeToken = (db: D1Database) =>
  first<ScimTokenRow>(db, `SELECT ${COLUMNS} FROM idp_scim_tokens WHERE state = 'active' LIMIT 1`);

export const pendingToken = (db: D1Database) =>
  first<ScimTokenRow>(db, `SELECT ${COLUMNS} FROM idp_scim_tokens WHERE state = 'pending' LIMIT 1`);

/** Retires any older pending token, then records the new one as pending, in one batch. */
export async function insertPending(
  db: D1Database,
  t: { id: string; sha256: string; now: number; createdBy: string },
): Promise<void> {
  await batch(db, [
    stmt(
      db,
      "UPDATE idp_scim_tokens SET state = 'retired', retired_at = ? WHERE state = 'pending'",
      [t.now],
    ),
    stmt(
      db,
      "INSERT INTO idp_scim_tokens (id, state, token_sha256, created_at, created_by) VALUES (?, 'pending', ?, ?, ?)",
      [t.id, t.sha256, t.now, t.createdBy],
    ),
  ]);
}

/**
 * Retires the active token and makes the pending one `id` active, in one batch. Does nothing unless `id` is
 * still pending. Returns whether it flipped.
 */
export async function flipToActive(db: D1Database, id: string, now: number): Promise<boolean> {
  const results = await batch(db, [
    stmt(
      db,
      `UPDATE idp_scim_tokens SET state = 'retired', retired_at = ?
       WHERE state = 'active' AND EXISTS (SELECT 1 FROM idp_scim_tokens WHERE id = ? AND state = 'pending')`,
      [now, id],
    ),
    stmt(
      db,
      "UPDATE idp_scim_tokens SET state = 'active', activated_at = ? WHERE id = ? AND state = 'pending'",
      [now, id],
    ),
  ]);
  return (results[1]?.meta.changes ?? 0) > 0;
}

/** Records a use, at most once a minute per token. */
export const touchAuth = (db: D1Database, id: string, now: number) =>
  run(
    db,
    'UPDATE idp_scim_tokens SET last_auth_at = ? WHERE id = ? AND (last_auth_at IS NULL OR last_auth_at <= ?)',
    [now, id, now - 60_000],
  );

/** Retires pending tokens created before `before`; they were never flipped. */
export const retireStalePending = (db: D1Database, before: number, now: number) =>
  run(
    db,
    "UPDATE idp_scim_tokens SET state = 'retired', retired_at = ? WHERE state = 'pending' AND created_at < ?",
    [now, before],
  );

export const purgeRetired = (db: D1Database, before: number) =>
  run(db, "DELETE FROM idp_scim_tokens WHERE state = 'retired' AND retired_at < ?", [before]);
