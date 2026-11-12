import { stmt } from '../../platform/db.ts';
import { boundOutputPredicate, type OutputPredicate } from './repo-output-predicates.ts';

export function liveReadFenceStmts(
  db: D1Database,
  pieces: readonly OutputPredicate[],
  orgId: string,
  mode: string,
): D1PreparedStatement[] | null {
  if (!pieces.length || pieces.some((part) => part.sql === '0')) return null;
  const packed = boundOutputPredicate({
    sql: pieces.map((part) => `(${part.sql})`).join(' AND '),
    params: pieces.flatMap((part) => part.params),
  });
  const bounded =
    packed.sql !== '0' && packed.params.length + 2 < 100
      ? [packed]
      : pieces.map(boundOutputPredicate);
  if (bounded.some((part) => part.sql === '0' || part.params.length + 2 >= 100)) return null;
  return bounded.map((part, index) =>
    stmt(
      db,
      `SELECT (${part.sql}) AS current, ${index} AS live_authority_part
     FROM (SELECT ? AS org_id, ? AS mode) scope`,
      [...part.params, orgId, mode],
    ),
  );
}
