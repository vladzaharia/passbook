import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, run } from '../../platform/db.ts';
import { effectiveReleaseIdSql } from './repo-release-heads.ts';

export interface StaleTemplate {
  id: string;
  /** The organization owning the passes, including for a global template. */
  orgId: string;
  mode: Mode;
  /** The approved version the passes should move to. */
  version: string;
  releaseId: string;
  generation: number;
  /** The release a rebuild was last queued for in this scope. */
  reissued: string | null;
}

// Each query supplies a pass scope as `s` and its template as `t`.
const activeReleaseJoin = `
  JOIN template_releases r ON r.id = (${effectiveReleaseIdSql({
    templateIdSql: 't.id',
    orgIdSql: 's.org_id',
    modeSql: 's.mode',
    providerSql: "'apple'",
  })})`;

const validActiveRelease = "t.status = 'active'";

const reissueJoin = `
  LEFT JOIN template_release_reissues q
    ON q.template_id = s.template_id AND q.org_id = s.org_id
    AND q.mode = s.mode AND q.provider = 'apple'`;

/** Active release scopes with passes whose release has been quiet and not yet queued. */
export async function quietUnqueuedTemplates(
  db: D1Database,
  before: number,
  limit: number,
): Promise<StaleTemplate[]> {
  const rows = await all<{
    id: string;
    org_id: string;
    mode: Mode;
    version: string;
    release_id: string;
    generation: number;
    reissued: string | null;
  }>(
    db,
    `WITH pass_scopes AS (
       SELECT DISTINCT template_id, org_id, mode FROM passes
       WHERE status = 'active' AND deleted_at IS NULL
     )
     SELECT t.id, s.org_id, s.mode, r.version, r.id AS release_id, r.generation,
       q.release_id AS reissued
     FROM pass_scopes s
     JOIN templates t ON t.id = s.template_id
     ${activeReleaseJoin}
     ${reissueJoin}
     WHERE ${validActiveRelease} AND r.created_at <= ? AND q.release_id IS NOT r.id
     ORDER BY r.created_at, t.id, s.org_id, s.mode LIMIT ?`,
    [before, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    mode: r.mode,
    version: r.version,
    releaseId: r.release_id,
    generation: r.generation,
    reissued: r.reissued,
  }));
}

/** Atomically claims the same active release and prior scope mark that were observed. */
export async function claimTemplateReissue(db: D1Database, t: StaleTemplate): Promise<boolean> {
  const { changes } = await run(
    db,
    `WITH pass_scope(template_id, org_id, mode) AS (VALUES (?, ?, ?))
     INSERT INTO template_release_reissues (template_id, org_id, mode, provider, release_id)
     SELECT s.template_id, s.org_id, s.mode, 'apple', r.id
     FROM pass_scope s
     JOIN templates t ON t.id = s.template_id
     ${activeReleaseJoin}
     ${reissueJoin}
     WHERE ${validActiveRelease}
       AND r.id = ? AND r.version = ? AND r.generation = ?
       AND q.release_id IS ? AND q.release_id IS NOT r.id
       AND EXISTS (
         SELECT 1 FROM passes p
         WHERE p.template_id = s.template_id AND p.org_id = s.org_id AND p.mode = s.mode
           AND p.status = 'active' AND p.deleted_at IS NULL
       )
     ON CONFLICT (template_id, org_id, mode, provider) DO UPDATE SET release_id = excluded.release_id
       WHERE template_release_reissues.release_id IS ?`,
    [t.id, t.orgId, t.mode, t.releaseId, t.version, t.generation, t.reissued, t.reissued],
  );
  return changes === 1;
}

/** Restore the previous mark only if this claim has not since been superseded. */
export async function releaseTemplateReissue(db: D1Database, t: StaleTemplate): Promise<void> {
  if (t.reissued === null) {
    await run(
      db,
      `DELETE FROM template_release_reissues
       WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = 'apple' AND release_id = ?`,
      [t.id, t.orgId, t.mode, t.releaseId],
    );
  } else {
    await run(
      db,
      `UPDATE template_release_reissues SET release_id = ?
       WHERE template_id = ? AND org_id = ? AND mode = ? AND provider = 'apple' AND release_id = ?`,
      [t.reissued, t.id, t.orgId, t.mode, t.releaseId],
    );
  }
}

/** Active passes on a different, non-equivalent version, optionally restricted to a scope. */
export async function countStalePasses(
  db: D1Database,
  templateId: string,
  version: string,
  orgId?: string,
  mode?: Mode,
): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM passes p
     LEFT JOIN template_versions pinned ON pinned.template_id = p.template_id AND pinned.version = p.template_version
     LEFT JOIN template_versions target ON target.template_id = p.template_id AND target.version = ?
     WHERE p.template_id = ? AND p.template_version != ? AND p.status = 'active' AND p.deleted_at IS NULL
       ${orgId === undefined ? '' : 'AND p.org_id = ?'}
       ${mode === undefined ? '' : 'AND p.mode = ?'}
       AND (pinned.build_key IS NULL OR target.build_key IS NULL OR pinned.build_key != target.build_key)`,
    [
      version,
      templateId,
      version,
      ...(orgId === undefined ? [] : [orgId]),
      ...(mode === undefined ? [] : [mode]),
    ],
  );
  return row?.n ?? 0;
}

/**
 * Active passes older than their scope's approved release. An aggregate is settled only when
 * every scope with older passes has queued its current release.
 */
export async function olderLivePasses(
  db: D1Database,
  templateId: string,
  mode: Mode = 'live',
  orgId?: string,
): Promise<{ older: number; settled: boolean }> {
  const row = await first<{ n: number; settled: number | null }>(
    db,
    `WITH s AS (
       SELECT DISTINCT template_id, org_id, mode FROM passes
       WHERE template_id = ? AND mode = ? AND status = 'active' AND deleted_at IS NULL
         ${orgId === undefined ? '' : 'AND org_id = ?'}
     )
     SELECT COUNT(*) AS n, MIN(CASE WHEN q.release_id = r.id THEN 1 ELSE 0 END) AS settled
     FROM s JOIN templates t ON t.id = s.template_id
     ${activeReleaseJoin}
     ${reissueJoin}
     JOIN passes p ON p.template_id = s.template_id AND p.org_id = s.org_id AND p.mode = s.mode
     LEFT JOIN template_versions pinned ON pinned.template_id = p.template_id AND pinned.version = p.template_version
     LEFT JOIN template_versions active ON active.template_id = t.id AND active.version = r.version
     WHERE p.template_version != r.version
       AND p.status = 'active' AND p.deleted_at IS NULL
       AND ${validActiveRelease}
       AND (pinned.build_key IS NULL OR active.build_key IS NULL OR pinned.build_key != active.build_key)`,
    [templateId, mode, ...(orgId === undefined ? [] : [orgId])],
  );
  return { older: row?.n ?? 0, settled: row?.settled === 1 };
}
