import { readPart } from '../../platform/authority-include.ts';

/** Reads the owner and revision of the pass the create batch just inserted. */
export const insertedPassRevisionPart = (passId: string) =>
  readPart(
    'SELECT owner_user_id, revision FROM passes WHERE passes.id = ? AND passes.org_id = {org}',
    [passId],
  );
