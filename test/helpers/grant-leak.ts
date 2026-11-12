import { withoutTrigger } from './triggers.ts';

/**
 * A grant row that outlives its batch is a builder bug (authority-epochs.md section 1.2). The worker
 * test setup runs this after every test; it deletes the rows first so one leak fails only one test.
 */
export async function assertNoLeakedGrants(db: D1Database): Promise<void> {
  const rows = await db.prepare('DELETE FROM authority_grants RETURNING id, purpose').all<{
    id: string;
    purpose: string;
  }>();
  await db.prepare('DELETE FROM authority_grant_leaks').run();
  if (rows.results.length > 0)
    throw new Error(
      `AUTHORITY_GRANT_LEAK: ${rows.results.map((r) => r.purpose).join(', ')} left a grant row behind`,
    );
}

/**
 * Plants a grant row that outlived its batch, which the sentinel foreign key makes impossible to commit.
 * A sentinel row with the same id satisfies the key; `assertNoLeakedGrants` removes both.
 */
export async function insertLeakedGrant(
  db: D1Database,
  row: {
    id: string;
    scope: 'org' | 'org_mode' | 'platform';
    orgId: string | null;
    mode: string | null;
    purpose: string;
  },
): Promise<void> {
  await withoutTrigger(db, 'authority_grant_leaks_never', () =>
    db.prepare('INSERT INTO authority_grant_leaks (id) VALUES (?)').bind(row.id).run(),
  );
  await db
    .prepare(
      `INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, created_at, leak_guard)
       VALUES (?, ?, ?, ?, 'membership:x', ?, 1, ?)`,
    )
    .bind(row.id, row.scope, row.orgId, row.mode, row.purpose, row.id)
    .run();
}
