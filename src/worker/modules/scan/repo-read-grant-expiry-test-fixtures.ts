/**
 * The last batch of a read: the output fences that decide what the answer discloses. A resolve ends in
 * the history bind whose authority term is the actor's read fence over the pass; a lookup ends in the
 * batch that reads the passes' standing (`AS pass_ok`).
 */
export function isFinalFenceBatch(sql: readonly string[]) {
  return sql.some(
    (text) =>
      (text.includes('ring AS MATERIALIZED') && text.includes('AS pass_ok')) ||
      (text.includes('AS authorized') && text.includes('EXISTS (WITH actor AS MATERIALIZED')),
  );
}
