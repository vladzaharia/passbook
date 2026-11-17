/**
 * The last batch of a read: the output fences that decide what the answer discloses. A resolve ends in
 * the actor check of `currentFoundActorStmt`; a lookup ends in the batch that reads the passes' heads.
 */
export function isFinalFenceBatch(sql: readonly string[]) {
  return sql.some(
    (text) =>
      text.includes('AS actor_authorized') ||
      (text.includes('AS releaseId') && text.includes('json_each')),
  );
}
