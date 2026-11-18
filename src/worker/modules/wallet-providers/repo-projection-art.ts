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
  input: {
    candidateId: string;
    templateId: string;
    orgId: string;
    hashes: readonly string[];
    now: number;
  },
): Promise<void> {
  for (const sha256 of input.hashes)
    await run(
      db,
      `INSERT INTO wallet_projection_art (candidate_id, sha256, template_id, org_id, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (candidate_id, sha256) DO NOTHING`,
      [input.candidateId, sha256, input.templateId, input.orgId, input.now],
    );
}

/** Drops the rows of a template or an organization and returns the hashes no other row names. */
export async function releaseProjectionArt(
  db: D1Database,
  scope: { templateId: string } | { orgId: string },
): Promise<string[]> {
  const [column, value] =
    'templateId' in scope ? ['template_id', scope.templateId] : ['org_id', scope.orgId];
  const rows = await all<{ sha256: string }>(
    db,
    `DELETE FROM wallet_projection_art WHERE ${column} = ? RETURNING sha256`,
    [value],
  );
  const hashes = [...new Set(rows.map((row) => row.sha256))];
  const unused: string[] = [];
  for (const sha256 of hashes)
    if (
      !(await first(db, 'SELECT 1 FROM wallet_projection_art WHERE sha256 = ? LIMIT 1', [sha256]))
    )
      unused.push(sha256);
  return unused;
}
