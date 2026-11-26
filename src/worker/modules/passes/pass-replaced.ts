import { ConflictError } from '../../platform/errors.ts';
import { replacedByOf } from './repo-pass-replaced.ts';

/**
 * The pass a moved pass was replaced by (following a chain of moves), or null for a pass nobody replaced.
 * It is set in the batch that voids the old pass, so a pass is never both live and replaced.
 */
export async function replacementOf(db: D1Database, passId: string): Promise<string | null> {
  let found: string | null = null;
  for (let at = passId, hops = 0; hops < 8; hops++) {
    const next = await replacedByOf(db, at);
    if (next === null) break;
    found = at = next;
  }
  return found;
}

/**
 * The id an API write by pass id lands on: a pass that was replaced forwards to its replacement, so an
 * integration that keeps writing the old id keeps the holder's pass current.
 */
export async function forwardedId(db: D1Database, passId: string): Promise<string> {
  return (await replacementOf(db, passId)) ?? passId;
}

/** A connector sync that would write or bind a replaced pass is refused: its replacement carries the state. */
export async function assertNotReplaced(db: D1Database, passId: string): Promise<void> {
  const to = await replacementOf(db, passId);
  if (to !== null)
    throw new ConflictError(`This pass was replaced. Use pass ${to}.`, 'PASS_REPLACED');
}
