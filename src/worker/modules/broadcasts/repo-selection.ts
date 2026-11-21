import type { Mode } from '../../../shared/contracts/common.ts';
import { all, first, run, stmt } from '../../platform/db.ts';

/** The templates of the chosen passes of this org and mode, and how many of the ids exist there (500 ids a query). */
export async function chosenPassTemplates(
  db: D1Database,
  orgId: string,
  mode: Mode,
  ids: readonly string[],
): Promise<{ templates: string[]; found: number }> {
  const templates = new Set<string>();
  let found = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await all<{ template_id: string }>(
      db,
      `SELECT template_id FROM passes WHERE org_id = ? AND mode = ? AND deleted_at IS NULL
         AND id IN (SELECT value FROM json_each(?))`,
      [orgId, mode, JSON.stringify(ids.slice(i, i + 500))],
    );
    found += rows.length;
    for (const r of rows) templates.add(r.template_id);
  }
  return { templates: [...templates], found };
}

/** An import's template, inside the org and mode, once it has ended and not been undone: its passes are then fixed. */
export const importTemplate = (db: D1Database, importId: string, orgId: string, mode: Mode) =>
  first<{ template_id: string; ended: number }>(
    db,
    `SELECT template_id, (state IN ('done', 'failed', 'stale', 'expired') AND reverted = 0) AS ended
     FROM pass_imports WHERE id = ? AND org_id = ? AND mode = ?`,
    [importId, orgId, mode],
  );

/** The statements that write a run's target rows, guarded by the save's token on the run's own row. */
const OWN_SAVE = `EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = ?1 AND json_extract(b.target, '$.token') = ?2)`;

/** Chosen passes of this org and mode become the run's target rows; a save over a draft clears the old ones first. */
export function chosenTargetsStmts(
  db: D1Database,
  b: {
    id: string;
    orgId: string;
    mode: Mode;
    token: string;
    ids: readonly string[];
    replace: boolean;
  },
): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  if (b.replace)
    out.push(
      stmt(db, `DELETE FROM broadcast_targets WHERE broadcast_id = ?1 AND ${OWN_SAVE}`, [
        b.id,
        b.token,
      ]),
    );
  out.push(
    stmt(
      db,
      `INSERT OR IGNORE INTO broadcast_targets (broadcast_id, pass_id)
       SELECT ?1, p.id FROM passes p WHERE p.org_id = ?3 AND p.mode = ?4 AND p.deleted_at IS NULL
         AND p.id IN (SELECT value FROM json_each(?5)) AND ${OWN_SAVE}`,
      [b.id, b.token, b.orgId, b.mode, JSON.stringify([...new Set(b.ids)])],
    ),
  );
  return out;
}

const UNFINISHED = `FROM broadcast_targets t WHERE t.broadcast_id = ?1 AND NOT EXISTS (
  SELECT 1 FROM broadcast_items i WHERE i.broadcast_id = t.broadcast_id AND i.pass_id = t.pass_id
    AND i.outcome IN ('updated', 'unchanged'))`;

/** A resumed run takes the passes its parent never changed (no item, or a failed one). */
export function resumeTargetsStmt(
  db: D1Database,
  b: { id: string; parentId: string; orgId: string; mode: Mode; token: string },
): D1PreparedStatement {
  return stmt(
    db,
    `INSERT OR IGNORE INTO broadcast_targets (broadcast_id, pass_id)
     SELECT ?2, t.pass_id ${UNFINISHED}
       AND EXISTS (SELECT 1 FROM broadcasts pb WHERE pb.id = ?1 AND pb.org_id = ?4 AND pb.mode = ?5)
       AND EXISTS (SELECT 1 FROM broadcasts b WHERE b.id = ?2 AND json_extract(b.target, '$.token') = ?3)`,
    [b.parentId, b.id, b.token, b.orgId, b.mode],
  );
}

/** How many passes a resume would take, and whether the parent ever had target rows. */
export async function resumableCount(
  db: D1Database,
  parentId: string,
  orgId: string,
  mode: Mode,
): Promise<{ left: number; all: number }> {
  const row = await first<{ left: number; all: number }>(
    db,
    `SELECT (SELECT COUNT(*) ${UNFINISHED}) AS left,
            (SELECT COUNT(*) FROM broadcast_targets WHERE broadcast_id = ?1) AS "all"
     WHERE EXISTS (SELECT 1 FROM broadcasts pb WHERE pb.id = ?1 AND pb.org_id = ?2 AND pb.mode = ?3)`,
    [parentId, orgId, mode],
  );
  return row ?? { left: 0, all: 0 };
}

/** Snapshots a page of pass ids into the run's target rows (the start of a run that matched a filter or an import). */
export const addTargets = (db: D1Database, broadcastId: string, ids: readonly string[]) =>
  run(
    db,
    'INSERT OR IGNORE INTO broadcast_targets (broadcast_id, pass_id) SELECT ?, value FROM json_each(?)',
    [broadcastId, JSON.stringify(ids)],
  );

/** Whether the run has any target rows yet. */
export const hasTargets = async (db: D1Database, broadcastId: string) =>
  (await first<{ one: number }>(
    db,
    'SELECT 1 AS one FROM broadcast_targets WHERE broadcast_id = ? LIMIT 1',
    [broadcastId],
  )) !== null;
