// Reads that commit with a grant (`Grant.commitWith`): they run after its release, in the same
// transaction, so they see its writes. They carry no authority, so they may not write.
import { AuthorityError } from './authority-error.ts';
import { assertReadOnly } from './authority-sqltext.ts';
import { exactStmt, type SqlValue } from './db.ts';
import { stripRaceTags } from './race-tag.ts';

/** Fixed read-only SQL and its values; only `afterRead` makes one. */
export interface AfterRead {
  readonly sql: string;
  readonly params: readonly SqlValue[];
}

const made = new WeakSet<AfterRead>();

/** A SELECT for `commitWith`. Write words, `;` and comments are refused here, before any batch runs. */
export function afterRead(sql: string, params: readonly SqlValue[] = []): AfterRead {
  const body = stripRaceTags(sql);
  assertReadOnly(body, 'A read after a grant');
  if (!/^\s*(?:select|with)\b/i.test(body))
    throw new AuthorityError('GRANT_SCOPE_OVERRIDE', 'A read after a grant is a SELECT.');
  const read = Object.freeze({ sql, params: Object.freeze([...params]) });
  made.add(read);
  return read;
}

/** The batch statements of `reads`; anything not built by `afterRead` is refused. */
export function prepareAfter(db: D1Database, reads: readonly AfterRead[]): D1PreparedStatement[] {
  return reads.map((r) => {
    if (!made.has(r))
      throw new AuthorityError(
        'GRANT_FOREIGN_STATEMENT',
        'A read after a grant is built by afterRead().',
      );
    return exactStmt(db, r.sql, r.params);
  });
}
