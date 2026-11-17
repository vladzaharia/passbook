import type { Mode } from '../../../shared/contracts/common.ts';
import { all, classifyD1Error } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';

export interface StampRow {
  stamps: number;
  cards: number;
  /** The goal these cards were last topped up to (0 when never). */
  kept: number;
}

interface Scope {
  templateId: string;
  mode: Mode;
  /** undefined reads every organization; null reads none. */
  orgId?: string | null;
}

const unreadable = (error: unknown): never => {
  if (classifyD1Error(error))
    throw new ConflictError('The stamp counts could not be read. Retry.', 'STAMPS_QUERY');
  throw error;
};

const orgClause = (q: Scope) => (q.orgId === undefined ? '' : ' AND org_id = ?');
const orgArgs = (q: Scope) => (q.orgId === undefined ? [] : [q.orgId]);

/** Template versions that have live cards in the scope. */
export async function stampVersions(db: D1Database, q: Scope): Promise<string[]> {
  if (q.orgId === null) return [];
  try {
    const rows = await all<{ v: string }>(
      db,
      `SELECT DISTINCT template_version AS v FROM passes
       WHERE template_id = ? AND mode = ? AND status = 'active' AND deleted_at IS NULL${orgClause(q)}`,
      [q.templateId, q.mode, ...orgArgs(q)],
    );
    return rows.map((r) => r.v);
  } catch (error) {
    return unreadable(error);
  }
}

/**
 * Live cards on one version by stamp count and top-up record, read from the pass's input (the
 * input name of that version). `input` is a plain name: stampsIssues refuses anything else.
 */
export async function stampHistogram(
  db: D1Database,
  q: Scope & { version: string; input: string },
): Promise<StampRow[]> {
  if (q.orgId === null) return [];
  try {
    const rows = await all<{ c: number | null; k: number; n: number }>(
      db,
      `SELECT CAST(json_extract(personalization, ?) AS INTEGER) AS c,
              COALESCE((SELECT MAX(CAST(substr(j.key, 13) AS INTEGER)) FROM json_each(passes.field_sources) j
                        WHERE j.key LIKE 'stamps.kept:%'), 0) AS k,
              COUNT(*) AS n
       FROM passes
       WHERE template_id = ? AND template_version = ? AND mode = ? AND status = 'active' AND deleted_at IS NULL${orgClause(q)}
       GROUP BY c, k`,
      [`$."${q.input}"`, q.templateId, q.version, q.mode, ...orgArgs(q)],
    );
    return rows.map((r) => ({ stamps: Math.max(0, r.c ?? 0), cards: r.n, kept: r.k }));
  } catch (error) {
    return unreadable(error);
  }
}
