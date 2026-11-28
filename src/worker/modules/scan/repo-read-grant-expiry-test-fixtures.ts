import { RACE_PASS_OK } from './race-tags.ts';

/**
 * The last batch of a read: the output fences that decide what the answer discloses. A resolve ends in
 * the history bind whose authority term is the actor's read fence over the pass; a lookup ends in the
 * batch that reads the passes' standing (`AS pass_ok`).
 */
export function isFinalFenceBatch(sql: readonly string[]) {
  return sql.some(
    (text) =>
      text.includes(RACE_PASS_OK) ||
      (text.includes('AS authorized') && text.includes('EXISTS (WITH actor AS MATERIALIZED')),
  );
}
