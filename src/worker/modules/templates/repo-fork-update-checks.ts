import type { Check } from '../../platform/authority-checks.ts';
import { first } from '../../platform/db.ts';

/** A refused merge write means the fork, its upstream or the offer moved after the job read them. */
export const FORK_STALE = 'TEMPLATE_FORK_STALE';

/** What a merge read about the fork. A write is refused unless all of it still holds. */
export interface ForkState {
  versions: number;
  newest: number;
  approvals: number;
  bases: number;
}

export async function readForkState(db: D1Database, templateId: string): Promise<ForkState> {
  const row = await first<ForkState>(
    db,
    `SELECT
       (SELECT count(*) FROM template_versions WHERE template_id = ?1) AS versions,
       COALESCE((SELECT max(created_at) FROM template_versions WHERE template_id = ?1), 0) AS newest,
       (SELECT count(*) FROM template_approvals a JOIN template_candidates c ON c.id = a.candidate_id
         WHERE c.template_id = ?1) AS approvals,
       (SELECT count(*) FROM template_version_bases WHERE template_id = ?1) AS bases`,
    [templateId],
  );
  if (!row) throw new Error('Could not read the fork state.');
  return row;
}

/**
 * The fork has the versions, approvals and base rows the merge read: no human save, approval or
 * merge landed since. Versions and base rows only grow, so equal counts mean nothing changed.
 */
export const forkUnchanged = (templateId: string, s: ForkState): Check => ({
  reason: 'lineage',
  ok: (b) =>
    `(SELECT count(*) FROM template_versions WHERE template_id = ${b.bind(templateId)}) = ${b.bind(s.versions)}
      AND COALESCE((SELECT max(created_at) FROM template_versions WHERE template_id = ${b.bind(templateId)}), 0) = ${b.bind(s.newest)}
      AND (SELECT count(*) FROM template_approvals a JOIN template_candidates c ON c.id = a.candidate_id
        WHERE c.template_id = ${b.bind(templateId)}) = ${b.bind(s.approvals)}
      AND (SELECT count(*) FROM template_version_bases WHERE template_id = ${b.bind(templateId)}) = ${b.bind(s.bases)}`,
});

/** The upstream is a baked template that still serves the version the merge used. */
export const upstreamActive = (id: string, version: string): Check => ({
  reason: 'stale',
  ok: (b) =>
    `EXISTS (SELECT 1 FROM templates u WHERE u.id = ${b.bind(id)} AND u.origin = 'baked'
      AND u.status = 'active' AND u.active_version = ${b.bind(version)})`,
});
