import type { ScanPredicate } from './scan-predicate.ts';

declare const afterCommitBrand: unique symbol;

/**
 * Authority already proven by a grant that committed after the reads it covers: the post-commit
 * batch of choose, answer and stop needs no second actor or pass fence. It can only be made from a
 * committed grant result, so a path that has not committed has no way to ask for an open fence.
 */
export interface AfterCommit extends ScanPredicate {
  readonly [afterCommitBrand]: true;
}

/** The marker for the batch that follows `Grant.commitWith`; refuses a result with no writes. */
export function afterCommit(committed: { readonly writes: readonly unknown[] }): AfterCommit {
  if (committed.writes.length === 0) throw new Error('No committed grant to stand for authority');
  return Object.freeze({ sql: '1', params: Object.freeze([]) }) as unknown as AfterCommit;
}
