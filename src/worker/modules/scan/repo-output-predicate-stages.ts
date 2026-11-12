import type { SqlValue } from '../../platform/db.ts';

type Predicate = { sql: string; params: readonly SqlValue[] };

/** Evaluate trusted conjuncts in one snapshot, without nesting their expression trees. */
export function stagedOutputQuery(
  parts: readonly Predicate[],
  bound: (input: Predicate) => Predicate,
  unpack: (input: Predicate) => string | null,
): Predicate | null {
  if (parts.length < 2) return null;
  const separator = '/* scan-output-authority-part */';
  const packed = bound({
    sql: parts.map((part) => `(${part.sql})`).join(separator),
    params: parts.flatMap((part) => part.params),
  });
  const expression = unpack(packed);
  if (expression === null) return null;
  const expressions = expression.split(separator);
  if (expressions.length !== parts.length) return null;
  const stages = expressions.map((part, index) => {
    const previous = index ? `output_authority_part_${index - 1}` : null;
    const condition = `CASE WHEN (${part}) THEN 1 ELSE 0 END`;
    return `output_authority_part_${index} AS MATERIALIZED (
      SELECT ${
        previous ? `CASE WHEN ${previous}.allowed=1 THEN ${condition} ELSE 0 END` : condition
      } AS allowed FROM output_bound_snapshot ${previous ? `CROSS JOIN ${previous}` : ''}
    )`;
  });
  const sql = `WITH output_bound_snapshot AS MATERIALIZED (SELECT json(?) AS data),
    ${stages.join(', ')}
    SELECT allowed AS authorized FROM output_authority_part_${parts.length - 1}`;
  return new TextEncoder().encode(sql).byteLength <= 90_000 ? { sql, params: packed.params } : null;
}
