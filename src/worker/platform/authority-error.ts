import { AppError } from './errors.ts';

export type AuthorityMisuse =
  | 'GRANT_NOT_JOB'
  | 'GRANT_BAD_PURPOSE'
  | 'GRANT_BAD_PRINCIPAL'
  | 'GRANT_FOREIGN_STATEMENT'
  | 'GRANT_STATEMENT_OUTSIDE_BATCH'
  | 'GRANT_SCOPE_OVERRIDE'
  | 'GRANT_UNGUARDED_TABLE'
  | 'GRANT_ALREADY_COMMITTED'
  | 'GRANT_BAD_IDENTIFIER'
  | 'GRANT_BATCH_MIXED'
  | 'GRANT_NO_EDGE'
  | 'GRANT_TABLE_NOT_ALLOWED'
  | 'SQL_BIND_BUDGET'
  | 'SQL_SIZE_BUDGET';

/** A programming error in a grant (never request-caused): always a 500 with a stable code. */
export class AuthorityError extends AppError {
  constructor(code: AuthorityMisuse, message: string) {
    super(code, 500, message);
  }
}
