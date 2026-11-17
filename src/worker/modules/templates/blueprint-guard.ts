import { ConflictError } from '../../platform/errors.ts';
import { isBlueprint } from './repo.ts';

export function blueprintRefusal(): ConflictError {
  return new ConflictError(
    'Passes come from templates. Use this blueprint to make one first.',
    'TEMPLATE_IS_BLUEPRINT',
  );
}

/** New passes never come from a blueprint. Passes already on one keep updating: only issue paths call this. */
export async function assertNotBlueprint(db: D1Database, templateId: string): Promise<void> {
  if (await isBlueprint(db, templateId)) throw blueprintRefusal();
}
