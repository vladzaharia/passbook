import { all, first, run, stmt } from '../../platform/db.ts';

export interface PushKeyRow {
  id: string;
  team_identifier: string;
  key_id: string;
  kek_version: number;
  iv: ArrayBuffer;
  wrapped_dek: ArrayBuffer;
  ciphertext: ArrayBuffer;
  created_by: string | null;
  created_at: number;
  rotated_at: number | null;
}

export interface PushKeyMeta {
  id: string;
  team_identifier: string;
  key_id: string;
  created_at: number;
  rotated_at: number | null;
}

const META = 'id, team_identifier, key_id, created_at, rotated_at';

export const getPushKeyRow = (db: D1Database, team: string) =>
  first<PushKeyRow>(db, 'SELECT * FROM apns_keys WHERE team_identifier = ?', [team]);

export const getPushKeyMeta = (db: D1Database, team: string) =>
  first<PushKeyMeta>(db, `SELECT ${META} FROM apns_keys WHERE team_identifier = ?`, [team]);

export const listPushKeyMeta = (db: D1Database, teams: readonly string[]) =>
  teams.length === 0
    ? Promise.resolve([] as PushKeyMeta[])
    : all<PushKeyMeta>(
        db,
        `SELECT ${META} FROM apns_keys WHERE team_identifier IN (${teams.map(() => '?').join(',')})`,
        teams,
      );

export interface PushKeyWrite {
  id: string;
  team: string;
  keyId: string;
  kekVersion: number;
  iv: Uint8Array;
  wrappedDek: Uint8Array;
  ciphertext: Uint8Array;
  createdBy: string | null;
  now: number;
}

/** Inserts the team's key, or replaces it in place (new id, so the AAD changes with it). */
export const replacePushKeyStmt = (db: D1Database, w: PushKeyWrite) =>
  stmt(
    db,
    `INSERT INTO apns_keys (id, team_identifier, key_id, kek_version, iv, wrapped_dek, ciphertext, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE id = ?), ?)
     ON CONFLICT(team_identifier) DO UPDATE SET id = excluded.id, key_id = excluded.key_id,
       kek_version = excluded.kek_version, iv = excluded.iv, wrapped_dek = excluded.wrapped_dek,
       ciphertext = excluded.ciphertext, created_by = excluded.created_by, rotated_at = excluded.created_at`,
    [w.id, w.team, w.keyId, w.kekVersion, w.iv, w.wrappedDek, w.ciphertext, w.createdBy, w.now],
  );

export const deletePushKeyStmt = (db: D1Database, team: string) =>
  stmt(db, 'DELETE FROM apns_keys WHERE team_identifier = ?', [team]);

/** Identities of the team with the binding each names; the key serves those without a present one. */
export const teamIdentityBindings = (db: D1Database, team: string) =>
  all<{ id: string; apns_binding: string | null }>(
    db,
    'SELECT id, apns_binding FROM signing_identities WHERE team_identifier = ?',
    [team],
  );

/** A new or removed key makes earlier push results meaningless for the identities that use it. */
export async function resetApnsHealth(db: D1Database, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await run(
    db,
    `UPDATE signing_identities SET apns_health = 'unknown' WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  );
}

/** Bindings of every identity of the given teams, for one page of identities. */
export const bindingsOfTeams = (db: D1Database, teams: readonly string[]) =>
  teams.length === 0
    ? Promise.resolve([] as { id: string; team_identifier: string; apns_binding: string | null }[])
    : all<{ id: string; team_identifier: string; apns_binding: string | null }>(
        db,
        `SELECT id, team_identifier, apns_binding FROM signing_identities
         WHERE team_identifier IN (${teams.map(() => '?').join(',')})`,
        teams,
      );
