import { classifyD1Error } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';

/** A commit that broke the active-name index (a create, rename or restore) is a 409, never a 500. */
export function nameTaken(error: unknown): never {
  const info = classifyD1Error(error);
  if (info?.kind === 'unique' && /scanners\.name|scanners_org_name/.test(info.detail))
    throw new ConflictError('Another scanner already has that name.', 'SCANNER_NAME_TAKEN');
  throw error;
}
