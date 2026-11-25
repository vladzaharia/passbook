import { all, first } from '../../platform/db.ts';
import type { Scope } from './repo-sweep.ts';

export interface GuestCandidate {
  id: string;
  org_id: string;
  created_at: number;
  personalization: string;
  /** `scan.access` and `inputs` of the pass's own template version. */
  access: string;
  inputs: string | null;
  /** The latest end among the pass's old visit rows, while that table exists. */
  visit_until: number | null;
}

/** An org-wide hold, or a hold on this pass. */
const heldSql = (org: string, pass: string) =>
  `EXISTS (SELECT 1 FROM retention_holds h WHERE h.released_at IS NULL AND h.org_id = ${org}
     AND (h.pass_id IS NULL OR h.pass_id = ${pass}))`;

/** The plan input's value: the pass's own, else the input's default. */
const PLAN_KEY = "json_extract(v.manifest, '$.scan.access.input.plan')";
const PLAN = `COALESCE(
  (SELECT pe.value FROM json_each(p.personalization) pe WHERE pe.key = ${PLAN_KEY} AND pe.type != 'null'),
  (SELECT json_extract(pr.value, '$.default') FROM json_each(v.manifest, '$.inputs.properties') pr
    WHERE pr.key = ${PLAN_KEY}))`;

/**
 * Live, undeleted passes created before `before` whose own template version has an access plan, whose plan
 * input names a guest plan, with no hold and no pending credential transfer; id order after the cursor.
 * The end is decided by the caller: it needs the time zone the door uses.
 */
export function guestCandidates(
  db: D1Database,
  before: number,
  after: string,
  limit: number,
  scope: Scope,
) {
  const where =
    scope.kind === 'org'
      ? { sql: 'p.org_id = ?', param: scope.orgId }
      : {
          sql: 'p.org_id NOT IN (SELECT value FROM json_each(?))',
          param: JSON.stringify(scope.exclude),
        };
  return all<GuestCandidate>(
    db,
    `SELECT p.id, p.org_id, p.created_at, p.personalization,
       json_extract(v.manifest, '$.scan.access') AS access, json_extract(v.manifest, '$.inputs') AS inputs,
       (SELECT MAX(vi.window_until) FROM visitors vi WHERE vi.pass_id = p.id) AS visit_until
     FROM passes p JOIN template_versions v ON v.template_id = p.template_id AND v.version = p.template_version
     WHERE p.deleted_at IS NULL AND p.created_at < ? AND p.id > ? AND ${where.sql}
       AND ${PLAN} IN (SELECT json_extract(pl.value, '$.id') FROM json_each(v.manifest, '$.scan.access.plans') pl
         WHERE json_extract(pl.value, '$.kind') = 'guest')
       AND NOT ${heldSql('p.org_id', 'p.id')}
       AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = p.id AND t.state = 'pending')
     ORDER BY p.id LIMIT ?`,
    [before, after, where.param, limit],
  );
}

/** A hold that landed after the page was read. */
export async function passHeld(db: D1Database, orgId: string, passId: string): Promise<boolean> {
  const row = await first<{ held: number }>(db, `SELECT ${heldSql('?', '?')} AS held`, [
    orgId,
    passId,
  ]);
  return row?.held === 1;
}
