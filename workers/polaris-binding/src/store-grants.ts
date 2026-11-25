import type { AccountClass, Target } from './types.ts';

export async function subjectClass(db: D1Database, subject: string): Promise<AccountClass | null> {
  const row = await db
    .prepare('SELECT class FROM idp_subjects WHERE subject = ?')
    .bind(subject)
    .first<{ class: AccountClass }>();
  return row?.class ?? null;
}

export async function liveGrants(db: D1Database, subject: string): Promise<Target[]> {
  const { results } = await db
    .prepare('SELECT target AS role FROM idp_grants WHERE subject = ? AND removed_at IS NULL')
    .bind(subject)
    .all<{ role: Target }>();
  return results.map((r) => r.role);
}

/** Subjects with a confirmed grant made at or before `by`. Pending and newer grants are not for a snapshot to end. */
export async function grantsOfRole(db: D1Database, role: Target, by: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      'SELECT subject FROM idp_grants WHERE target = ? AND removed_at IS NULL AND confirmed_at IS NOT NULL AND confirmed_at <= ?',
    )
    .bind(role, by)
    .all<{ subject: string }>();
  return results.map((r) => r.subject);
}

/** Recorded before the write, pending until it is read back: a lost answer must not leave a role PassBook cannot take back. */
export async function recordAdded(
  db: D1Database,
  subject: string,
  roles: Target[],
  ref: string,
  at: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO idp_subjects (subject, class, created_at) VALUES (?, 'linked', ?)
         ON CONFLICT (subject) DO UPDATE SET class = CASE WHEN class = 'external' THEN 'linked' ELSE class END`,
      )
      .bind(subject, at),
    ...roles.map((role) =>
      db
        .prepare(
          "INSERT OR IGNORE INTO idp_grants (subject, target, source, ref, created_at) VALUES (?, ?, 'added', ?, ?)",
        )
        .bind(subject, role, ref, at),
    ),
  ]);
}

/** Everyone with a live grant for the role, pending ones included. */
export async function liveGrantSubjects(db: D1Database, role: Target): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT subject FROM idp_grants WHERE target = ? AND removed_at IS NULL')
    .bind(role)
    .all<{ subject: string }>();
  return results.map((r) => r.subject);
}

/** The write was read back: the grants are real. */
export async function confirmGrants(
  db: D1Database,
  subject: string,
  roles: Target[],
  at: number,
): Promise<void> {
  await db.batch(
    roles.map((role) =>
      db
        .prepare(
          'UPDATE idp_grants SET confirmed_at = ? WHERE subject = ? AND target = ? AND removed_at IS NULL AND confirmed_at IS NULL',
        )
        .bind(at, subject, role),
    ),
  );
}

/** Grants a snapshot ended because the member left the group, since `since`. */
export async function endedSince(
  db: D1Database,
  since: number,
): Promise<{ subject: string; role: Target }[]> {
  const { results } = await db
    .prepare(
      "SELECT subject, target AS role FROM idp_grants WHERE removed_reason = 'idp_removed' AND removed_at >= ? ORDER BY id",
    )
    .bind(since)
    .all<{ subject: string; role: Target }>();
  return results;
}

/** The account was seen enabled, so a disable mark of the binding's is stale. */
export async function clearDisabledMarks(db: D1Database, subjects: string[]): Promise<void> {
  if (!subjects.length) return;
  await db
    .prepare(
      `UPDATE idp_subjects SET disabled_by_binding_at = NULL WHERE disabled_by_binding_at IS NOT NULL AND subject IN (${subjects.map(() => '?').join(',')})`,
    )
    .bind(...subjects)
    .run();
}

export async function endGrants(
  db: D1Database,
  subject: string,
  roles: Target[],
  reason: string,
  at: number,
): Promise<void> {
  await db.batch(
    roles.map((role) =>
      db
        .prepare(
          'UPDATE idp_grants SET removed_at = ?, removed_reason = ? WHERE subject = ? AND target = ? AND removed_at IS NULL',
        )
        .bind(at, reason, subject, role),
    ),
  );
}

/** An override removal of a role the binding never added: a spent row, so the ledger of grants shows it. */
export async function recordOverride(
  db: D1Database,
  subject: string,
  roles: Target[],
  ref: string,
  at: number,
): Promise<void> {
  await db.batch(
    roles.map((role) =>
      db
        .prepare(
          `INSERT INTO idp_grants (subject, target, source, ref, created_at, removed_at, removed_reason)
           VALUES (?, ?, 'override', ?, ?, ?, 'override')`,
        )
        .bind(subject, role, ref, at, at),
    ),
  );
}

export async function noteExternal(db: D1Database, subject: string, at: number): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO idp_subjects (subject, class, created_at) VALUES (?, 'external', ?)",
    )
    .bind(subject, at)
    .run();
}

export async function markDisabled(
  db: D1Database,
  subject: string,
  at: number | null,
): Promise<void> {
  await db
    .prepare('UPDATE idp_subjects SET disabled_by_binding_at = ? WHERE subject = ?')
    .bind(at, subject)
    .run();
}

export async function disabledByBinding(db: D1Database, subject: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT disabled_by_binding_at AS at FROM idp_subjects WHERE subject = ?')
    .bind(subject)
    .first<{ at: number | null }>();
  return row?.at != null;
}
