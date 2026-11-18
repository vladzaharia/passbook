import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first } from '../../platform/db.ts';
import type { UpdateKey } from './fork-updates-write.ts';
import { FORK_STALE } from './repo-fork-update-checks.ts';

/**
 * Only platform-wide templates (blueprints, starters) and the fork's own org's baked templates may
 * supply files to a fork's merge or save. A copy of another org's template has lineage but is
 * detached for file content, and so is a fork of another org's built-in.
 */
export async function upstreamReadable(
  db: D1Database,
  upstreamId: string,
  forkId: string,
): Promise<boolean> {
  return !!(await first(
    db,
    `SELECT 1 FROM templates u JOIN templates f ON f.id = ?
     WHERE u.id = ? AND u.status != 'deleted'
       AND (u.org_id IS NULL OR (u.origin = 'baked' AND u.org_id = f.org_id))`,
    [forkId, upstreamId],
  ));
}

export interface Tip {
  version: string;
  createdAt: number;
  createdBy: string | null;
}

/** `v` is not a merge version nobody has accepted: no peer or sole approval (a Test approval is not acceptance) and no human save built on it. */
export const TIP_FILTER = `NOT (
  EXISTS (SELECT 1 FROM template_version_bases m
    WHERE m.template_id = v.template_id AND m.version = v.version AND m.via = 'merge')
  AND NOT EXISTS (SELECT 1 FROM template_candidates c
    JOIN template_approvals a ON a.candidate_id = c.id
    WHERE c.template_id = v.template_id AND c.version = v.version AND a.kind != 'test')
  AND NOT EXISTS (SELECT 1 FROM template_version_bases e
    WHERE e.template_id = v.template_id AND e.parent_version = v.version
      AND e.via IN ('edit', 'resolve'))
)`;

/** The fork's newest version that is not an unaccepted merge: such a version is an offer, not the fork's content. */
export async function forkTip(db: D1Database, templateId: string): Promise<Tip | null> {
  const row = await first<Tip>(
    db,
    `SELECT v.version, v.created_at AS createdAt, v.created_by AS createdBy
     FROM template_versions v WHERE v.template_id = ? AND ${TIP_FILTER}
     ORDER BY v.created_at DESC, v.version DESC LIMIT 1`,
    [templateId],
  );
  return row ?? null;
}

/**
 * Whether someone other than the author reviewed the version: a peer approval on any candidate. A
 * Test or sole approval is the author's own, so it does not make their edits reviewed.
 */
export async function hasApproval(
  db: D1Database,
  templateId: string,
  version: string,
): Promise<boolean> {
  return !!(await first(
    db,
    `SELECT 1 FROM template_candidates c JOIN template_approvals a ON a.candidate_id = c.id
     WHERE c.template_id = ? AND c.version = ? AND a.kind = 'peer' LIMIT 1`,
    [templateId, version],
  ));
}

/** The modes in which the fork has an Apple release: a merge gets a candidate in each. */
export async function releaseModes(
  db: D1Database,
  templateId: string,
  orgId: string,
): Promise<Mode[]> {
  const rows = await all<{ mode: Mode }>(
    db,
    `SELECT DISTINCT mode FROM template_releases
     WHERE template_id = ? AND org_id = ? AND provider = 'apple' ORDER BY mode`,
    [templateId, orgId],
  );
  return rows.map((r) => r.mode);
}

export interface ForkRow {
  upstream: string;
  tracking: string;
  org: string;
  createdAt: number;
}

/** The fork's lineage row as the merge job reads it. */
export async function getForkRow(db: D1Database, templateId: string): Promise<ForkRow | null> {
  return first<ForkRow>(
    db,
    `SELECT upstream_id AS upstream, tracking, org_id AS org, created_at AS createdAt
     FROM template_forks WHERE template_id = ?`,
    [templateId],
  );
}

/** Forks planned per tick: the rest wait for the next minute. */
const BATCH = 20;

export interface Due {
  templateId: string;
  orgId: string;
  upstreamId: string;
  upstreamVersion: string;
  tip: string;
}

/**
 * Tracked, active forks of an active baked template whose tip has no offer for the upstream's active
 * version and does not already incorporate it (or anything newer).
 */
const DUE_SQL = `
  WITH tips AS (
    SELECT f.template_id AS templateId, f.org_id AS orgId, f.upstream_id AS upstreamId,
      u.active_version AS upstreamVersion,
      (SELECT v.version FROM template_versions v WHERE v.template_id = f.template_id AND ${TIP_FILTER}
       ORDER BY v.created_at DESC, v.version DESC LIMIT 1) AS tip
    FROM template_forks f
    JOIN templates t ON t.id = f.template_id AND t.status = 'active'
    JOIN orgs o ON o.id = f.org_id AND o.status = 'active'
    JOIN templates u ON u.id = f.upstream_id AND u.origin = 'baked' AND u.status = 'active'
      AND u.active_version IS NOT NULL
    WHERE f.tracking = 'on'
  )
  SELECT d.templateId, d.orgId, d.upstreamId, d.upstreamVersion, d.tip FROM tips d
  WHERE d.tip IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM template_fork_updates x WHERE x.template_id = d.templateId
      AND x.ours_version = d.tip AND x.upstream_version = d.upstreamVersion)
    AND NOT EXISTS (SELECT 1 FROM template_version_bases b
      JOIN template_versions bv ON bv.template_id = b.upstream_id AND bv.version = b.upstream_version
      JOIN template_versions cur ON cur.template_id = d.upstreamId AND cur.version = d.upstreamVersion
      WHERE b.template_id = d.templateId AND b.version = d.tip AND bv.created_at >= cur.created_at)
  ORDER BY d.templateId LIMIT ${BATCH}`;

export const dueForks = (db: D1Database) => all<Due>(db, DUE_SQL);

/** Offers that never finished: stuck pending, or failed for a reason a retry can fix. */
const RETRY_SQL = `
  SELECT x.id, x.org_id AS orgId, x.template_id AS templateId, x.upstream_id AS upstreamId,
    x.upstream_version AS upstreamVersion, x.ours_version AS oursVersion
  FROM template_fork_updates x
  JOIN template_forks f ON f.template_id = x.template_id AND f.tracking = 'on'
  JOIN orgs o ON o.id = x.org_id AND o.status = 'active'
  WHERE x.status IN ('pending', 'failed') AND x.attempts < ? AND x.updated_at < ?
    AND COALESCE(json_extract(x.summary, '$.code'), '') != ?
  ORDER BY x.updated_at LIMIT ${BATCH}`;

/** Offers that never finished, not yet tried `maxAttempts` times and idle since before `idleBefore`. */
export const retryableOffers = (db: D1Database, idleBefore: number, maxAttempts: number) =>
  all<UpdateKey>(db, RETRY_SQL, [maxAttempts, idleBefore, FORK_STALE]);

export interface Offer extends UpdateKey {
  status: string;
}
export async function getOffer(db: D1Database, id: string): Promise<Offer | null> {
  return first<Offer>(
    db,
    `SELECT id, org_id AS orgId, template_id AS templateId, upstream_id AS upstreamId,
       upstream_version AS upstreamVersion, ours_version AS oursVersion, status
     FROM template_fork_updates WHERE id = ?`,
    [id],
  );
}

/** Offers still waiting for their job: new enough that the queue may simply be behind. */
export async function pendingOffers(db: D1Database, since: number): Promise<number> {
  const row = await first<{ n: number }>(
    db,
    "SELECT count(*) AS n FROM template_fork_updates WHERE status = 'pending' AND updated_at >= ?",
    [since],
  );
  return row?.n ?? 0;
}

/**
 * A cheap, sound pre-check for `dueForks`: some tracked fork has no offer for its upstream's active
 * version at its newest version. The newest version is the tip unless an unaccepted merge sits on
 * top, which only makes this say yes more often, never no when a fork is due.
 */
export async function anyDue(db: D1Database): Promise<boolean> {
  return !!(await first(
    db,
    `SELECT 1 FROM template_forks f
     JOIN templates u ON u.id = f.upstream_id AND u.origin = 'baked' AND u.status = 'active'
       AND u.active_version IS NOT NULL
     WHERE f.tracking = 'on' AND NOT EXISTS (SELECT 1 FROM template_fork_updates x
       WHERE x.template_id = f.template_id AND x.upstream_version = u.active_version
         AND x.ours_version = (SELECT v.version FROM template_versions v
           WHERE v.template_id = f.template_id ORDER BY v.created_at DESC, v.version DESC LIMIT 1))
     LIMIT 1`,
  ));
}

export async function orgActive(db: D1Database, orgId: string): Promise<boolean> {
  return !!(await first(db, "SELECT 1 FROM orgs WHERE id = ? AND status = 'active'", [orgId]));
}

/** Forks that have had an offer, the most recently active first. */
export async function forksWithOffers(
  db: D1Database,
  limit: number,
): Promise<{ templateId: string; orgId: string }[]> {
  return all<{ templateId: string; orgId: string }>(
    db,
    `SELECT template_id AS templateId, org_id AS orgId FROM template_fork_updates
     GROUP BY template_id, org_id ORDER BY max(updated_at) DESC LIMIT ?`,
    [limit],
  );
}

export async function versionExists(db: D1Database, templateId: string, version: string) {
  return !!(await first(
    db,
    'SELECT 1 FROM template_versions WHERE template_id = ? AND version = ?',
    [templateId, version],
  ));
}
