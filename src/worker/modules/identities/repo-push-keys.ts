import { all, first, run } from '../../platform/db.ts';

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

/** `created_by` is stored only when the user exists (API keys and tests have none). */
/** Inserts the team's key, or replaces it in place (new id, so the AAD changes with it). */
export async function replacePushKey(db: D1Database, w: PushKeyWrite): Promise<boolean> {
  const existing = await first<{ id: string }>(
    db,
    'SELECT id FROM apns_keys WHERE team_identifier = ?',
    [w.team],
  );
  if (existing) {
    await run(
      db,
      `UPDATE apns_keys SET id = ?, key_id = ?, kek_version = ?, iv = ?, wrapped_dek = ?, ciphertext = ?,
         created_by = (SELECT id FROM users WHERE id = ?), rotated_at = ? WHERE team_identifier = ?`,
      [w.id, w.keyId, w.kekVersion, w.iv, w.wrappedDek, w.ciphertext, w.createdBy, w.now, w.team],
    );
    return true;
  }
  await run(
    db,
    `INSERT INTO apns_keys (id, team_identifier, key_id, kek_version, iv, wrapped_dek, ciphertext, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, (SELECT id FROM users WHERE id = ?), ?)`,
    [w.id, w.team, w.keyId, w.kekVersion, w.iv, w.wrappedDek, w.ciphertext, w.createdBy, w.now],
  );
  return false;
}

export async function deletePushKey(db: D1Database, team: string): Promise<boolean> {
  const result = await run(db, 'DELETE FROM apns_keys WHERE team_identifier = ?', [team]);
  return result.changes > 0;
}

/** Identities of the team: the ones its push key serves. */
export async function teamIdentityCount(db: D1Database, team: string): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    'SELECT count(*) AS n FROM signing_identities WHERE team_identifier = ?',
    [team],
  );
  return row?.n ?? 0;
}

/** A new or removed key makes earlier push results meaningless for the team's identities. */
export async function resetTeamApnsHealth(db: D1Database, team: string): Promise<void> {
  await run(db, "UPDATE signing_identities SET apns_health = 'unknown' WHERE team_identifier = ?", [
    team,
  ]);
}
