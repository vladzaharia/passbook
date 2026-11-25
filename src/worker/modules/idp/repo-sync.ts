import { all, batch, chunk, placeholders, run } from '../../platform/db.ts';
import type { IdentityRow } from './repo-sources.ts';
import type { TargetStateRow } from './repo-state.ts';

const STATE_COLUMNS =
  'subject, target, user_id, observed, presence, held_at, applied_at, observed_at, error_code';

/** The PassBook users behind Polaris ID subjects, in chunks. A subject nobody linked is absent from the map. */
export async function identitiesOfSubjects(
  db: D1Database,
  subjects: readonly string[],
): Promise<Map<string, IdentityRow>> {
  const out = new Map<string, IdentityRow>();
  for (const part of chunk(subjects)) {
    const rows = await all<IdentityRow & { subject: string }>(
      db,
      `SELECT a.subject, u.id AS user_id, u.status, u.last_roles FROM auth_identities a JOIN users u ON u.id = a.user_id
       WHERE a.provider = 'pocketid' AND a.subject IN (${placeholders(part.length)})`,
      part,
    );
    for (const row of rows) out.set(row.subject, row);
  }
  return out;
}

/** Recorded target states of subjects, by subject. */
export async function statesOfSubjects(
  db: D1Database,
  subjects: readonly string[],
): Promise<Map<string, TargetStateRow[]>> {
  const out = new Map<string, TargetStateRow[]>();
  for (const part of chunk(subjects)) {
    const rows = await all<TargetStateRow>(
      db,
      `SELECT ${STATE_COLUMNS} FROM idp_target_state WHERE subject IN (${placeholders(part.length)}) ORDER BY subject, target`,
      part,
    );
    for (const row of rows) out.set(row.subject, [...(out.get(row.subject) ?? []), row]);
  }
  return out;
}

/**
 * Linked, active, non-admin users with a live reason for console, developer or support that the drain has never
 * seen: no recorded state and no mark. The first drain gives them a state row, so the list shrinks by itself.
 */
export async function unobservedWanted(db: D1Database, limit: number): Promise<string[]> {
  const rows = await all<{ subject: string }>(
    db,
    `SELECT DISTINCT a.subject FROM auth_identities a
     JOIN users u ON u.id = a.user_id AND u.status = 'active' AND u.last_roles NOT LIKE '%"admin"%'
     WHERE a.provider = 'pocketid'
       AND NOT EXISTS (SELECT 1 FROM idp_target_state s WHERE s.subject = a.subject)
       AND NOT EXISTS (SELECT 1 FROM idp_dirty d WHERE d.subject = a.subject)
       AND (EXISTS (SELECT 1 FROM org_memberships m JOIN orgs o ON o.id = m.org_id
                    WHERE m.user_id = a.user_id AND m.revoked_at IS NULL
                      AND o.status IN ('active', 'suspended') AND o.personal_user_id IS NULL)
         OR EXISTS (SELECT 1 FROM developer_sponsors p WHERE p.user_id = a.user_id AND p.ended_at IS NULL)
         OR EXISTS (SELECT 1 FROM platform_role_grants g WHERE g.user_id = a.user_id AND g.revoked_at IS NULL))
     ORDER BY a.subject LIMIT ?`,
    [limit],
  );
  return rows.map((r) => r.subject);
}

/** Open differences the drain can act on, once a live run is possible again (after a dry-run week). */
export async function actionableDriftSubjects(db: D1Database, limit: number): Promise<string[]> {
  const rows = await all<{ subject: string }>(
    db,
    `SELECT DISTINCT subject FROM idp_drift
     WHERE resolved_at IS NULL AND kind IN ('missing', 'unexpected', 'apply_failed') ORDER BY subject LIMIT ?`,
    [limit],
  );
  return rows.map((r) => r.subject);
}

/** Ended sponsorships of a user whose group effect is settled. Returns how many settled. */
export async function settleEndedSponsors(
  db: D1Database,
  userId: string,
  now: number,
): Promise<number> {
  return (
    await run(
      db,
      `UPDATE developer_sponsors SET settled_at = MAX(?, ended_at)
       WHERE user_id = ? AND ended_at IS NOT NULL AND settled_at IS NULL`,
      [now, userId],
    )
  ).changes;
}

/** Marks subjects for the next drain in one statement per chunk; a mark resets the backoff, like `markDirty`. */
export async function markManyDirty(db: D1Database, subjects: readonly string[]): Promise<void> {
  for (const part of chunk(subjects, 40))
    await run(
      db,
      `INSERT INTO idp_dirty (subject) VALUES ${part.map(() => '(?)').join(',')}
       ON CONFLICT (subject) DO UPDATE SET version = version + 1, attempts = 0, next_at = 0`,
      part,
    );
}

/** Linked users whose last sign-in held the admin role: the ones the platform admin group must still list. */
export const linkedAdmins = (db: D1Database, limit: number) =>
  all<{ subject: string; user_id: string }>(
    db,
    `SELECT a.subject, u.id AS user_id FROM auth_identities a JOIN users u ON u.id = a.user_id
     WHERE a.provider = 'pocketid' AND u.status = 'active' AND u.last_roles LIKE '%"admin"%'
     ORDER BY a.subject LIMIT ?`,
    [limit],
  );

/** A reconcile checked the subject against D1: its states move to the back of the next run's order. */
export const touchObserved = (db: D1Database, subject: string, now: number) =>
  run(
    db,
    'UPDATE idp_target_state SET observed_at = ? WHERE subject = ? AND observed IS NOT NULL',
    [now, subject],
  );

/** Runs prepared writes fifty to a round trip, so a long list costs a few queries and not hundreds. */
export async function flush(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (const part of chunk(statements, 50)) await batch(db, part);
}
