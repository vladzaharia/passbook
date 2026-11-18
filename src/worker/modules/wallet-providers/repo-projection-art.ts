import { all, first, run } from '../../platform/db.ts';

/** The Q21 memo for a candidate under one pipeline revision, or null when not yet checked. */
export async function getPauseCheck(
  db: D1Database,
  candidateId: string,
  pipeline: string,
): Promise<boolean | null> {
  const row = await first<{ paused: number }>(
    db,
    'SELECT paused FROM wallet_projection_pause_checks WHERE candidate_id = ? AND pipeline = ?',
    [candidateId, pipeline],
  );
  return row ? row.paused === 1 : null;
}

export async function putPauseCheck(
  db: D1Database,
  input: { candidateId: string; pipeline: string; paused: boolean; now: number },
): Promise<void> {
  await run(
    db,
    `INSERT INTO wallet_projection_pause_checks (candidate_id, pipeline, paused, checked_at)
    VALUES (?, ?, ?, ?) ON CONFLICT (candidate_id, pipeline) DO NOTHING`,
    [input.candidateId, input.pipeline, input.paused ? 1 : 0, input.now],
  );
}

/** Records the art copies a publication wrote, before the release that names them is inserted. */
export async function recordProjectionArt(
  db: D1Database,
  input: { candidateId: string; hashes: readonly string[]; now: number },
): Promise<void> {
  for (const sha256 of input.hashes)
    await run(
      db,
      `INSERT INTO wallet_projection_art (candidate_id, sha256, created_at)
      VALUES (?, ?, ?) ON CONFLICT (candidate_id, sha256) DO NOTHING`,
      [input.candidateId, sha256, input.now],
    );
}

export type ArtScope = { templateId: string } | { orgId: string };
const column = (scope: ArtScope) =>
  'templateId' in scope
    ? { sql: 'c.template_id', value: scope.templateId }
    : { sql: 'c.org_id', value: scope.orgId };

/** Every art hash a template's or organization's candidates recorded, and whether another scope shares it. */
export async function listProjectionArt(
  db: D1Database,
  scope: ArtScope,
): Promise<{ sha256: string; shared: boolean }[]> {
  const { sql, value } = column(scope);
  const rows = await all<{ sha256: string; shared: number }>(
    db,
    `SELECT DISTINCT a.sha256,
      EXISTS (SELECT 1 FROM wallet_projection_art other
        JOIN template_candidates oc ON oc.id = other.candidate_id
        WHERE other.sha256 = a.sha256 AND NOT (${sql.replace('c.', 'oc.')} = ?)) AS shared
    FROM wallet_projection_art a JOIN template_candidates c ON c.id = a.candidate_id
    WHERE ${sql} = ?`,
    [value, value],
  );
  return rows.map((row) => ({ sha256: row.sha256, shared: row.shared === 1 }));
}

/** Forgets one hash for a scope, after its object is gone or because another scope still needs it. */
export async function forgetProjectionArt(
  db: D1Database,
  scope: ArtScope,
  sha256: string,
): Promise<void> {
  const { sql, value } = column(scope);
  await run(
    db,
    `DELETE FROM wallet_projection_art WHERE sha256 = ? AND candidate_id IN
      (SELECT c.id FROM template_candidates c WHERE ${sql} = ?)`,
    [sha256, value],
  );
}

/** An organization with a pass that is not removed or deleted can still present its wallet objects. */
export async function orgHasLivePasses(db: D1Database, orgId: string): Promise<boolean> {
  return (
    (await first(
      db,
      'SELECT 1 FROM passes WHERE org_id = ? AND removed_at IS NULL AND deleted_at IS NULL LIMIT 1',
      [orgId],
    )) !== null
  );
}
