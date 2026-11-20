// Refusals and table rules of a grant, kept out of authority.ts for its size.
import { AuthorityError } from './authority-error.ts';
import { authorityDenial, builtOf, type GrantedStatement } from './authority-granted.ts';
import type { Principal } from './authority-principal.ts';
import { assertBudget, PARAM_BUDGET, WRITE_PARAM_BUDGET } from './authority-statements.ts';
import { RESTRICTED_TABLES } from './authority-tables.ts';
import { authorityDenied, type DenialOptions } from './errors.ts';

/** Maps an `authority_denied:*` abort to the HTTP error; any other error is returned unchanged. */
export function translateDenial(
  error: unknown,
  principal: Principal,
  codes: DenialOptions['codes'] | undefined,
): unknown {
  const reason = authorityDenial(error);
  if (reason === null) return error;
  return authorityDenied(reason, {
    scanner: principal.kind === 'scanner',
    ...(codes ? { codes } : {}),
  });
}

/** A write to a table only some purposes write, or outside the grant's `tables`, is a programming error. */
export function assertTableAllowed(
  purpose: string,
  tables: ReadonlySet<string> | undefined,
  table: string,
): string {
  const only = RESTRICTED_TABLES[table.toLowerCase()];
  if (only && !only.includes(purpose))
    throw new AuthorityError(
      'GRANT_TABLE_NOT_ALLOWED',
      `${table} is written only by ${only.join(' or ')}.`,
    );
  if (tables && !tables.has(table.toLowerCase()))
    throw new AuthorityError('GRANT_TABLE_NOT_ALLOWED', `${purpose} does not write ${table}.`);
  return table;
}

/** A statement added to a grant must have been built by it, and fit the budgets. */
export function assertOwnStatement(s: GrantedStatement, grantId: string): void {
  const built = builtOf(s);
  if (built.grantId !== grantId)
    throw new AuthorityError(
      'GRANT_FOREIGN_STATEMENT',
      'A statement belongs to a different grant.',
    );
  assertBudget(built.sql, built.params, built.read ? PARAM_BUDGET : WRITE_PARAM_BUDGET);
}
