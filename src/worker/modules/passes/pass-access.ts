import { NotFoundError } from '../../platform/errors.ts';
import { getPass, type Pass } from './repo.ts';
import { assertWritableMode, type ScopeArg } from './scope.ts';

/** Reads a pass for a change: missing, out of org, or (for API keys and sessions) the other mode fails. */
export async function getPassForWrite(db: D1Database, id: string, scope: ScopeArg): Promise<Pass> {
  const pass = await getPass(db, id, scope);
  if (!pass) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  assertWritableMode(scope, pass.mode);
  return pass;
}
