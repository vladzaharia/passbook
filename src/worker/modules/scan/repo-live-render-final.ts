import { stmt } from '../../platform/db.ts';
import { boundOutputPredicate, type OutputPredicate } from './repo-output-predicates.ts';

export interface LiveRenderFence {
  row: number;
  kind: number;
  statements: D1PreparedStatement[];
}

/** Each split SELECT is independently bounded, but all are executed in one D1 batch. */
export function liveRenderFence(
  db: D1Database,
  pieces: readonly OutputPredicate[] | null,
  orgId: string,
  mode: string,
  row: number,
  kind: number,
): LiveRenderFence | null {
  if (!pieces?.length || pieces.some((part) => part.sql === '0')) return null;
  const combined = boundOutputPredicate({
    sql: pieces.map((part) => `(${part.sql})`).join(' AND '),
    params: pieces.flatMap((part) => part.params),
  });
  const parts =
    combined.sql !== '0' && combined.params.length + 2 < 100
      ? [combined]
      : pieces.map(boundOutputPredicate);
  if (parts.some((part) => part.sql === '0' || part.params.length + 2 >= 100)) return null;
  return {
    row,
    kind,
    statements: parts.map((part, index) =>
      stmt(
        db,
        `SELECT (${part.sql}) AS current, ${row} AS live_row_index, ${kind} AS live_row_kind,
        ${index} AS live_row_part FROM (SELECT ? AS org_id, ? AS mode) scope`,
        [...part.params, orgId, mode],
      ),
    ),
  };
}

export function liveRenderVisibilityPredicate(now: number, visibleUntil: number): OutputPredicate {
  return { sql: '? <= ?', params: [now, visibleUntil] };
}

export function liveRenderReceiptStmt(db: D1Database): D1PreparedStatement {
  return stmt(db, 'SELECT 1 AS live_render_final');
}
