import type { Grant } from '../../platform/authority.ts';
import { AppError } from '../../platform/errors.ts';
import { addUndoWrites, openUndoGrant } from './repo-undo-grant.ts';
import { addOccupancyUndo } from './repo-undo-occupancy.ts';
import type { UndoCommit } from './repo-undo-types.ts';

export { UNDO_CODES } from './repo-undo-grant.ts';
export type { UndoCommit, UndoGate, UndoPresence } from './repo-undo-types.ts';

/**
 * One batch. The gate, presence and target compare-and-swaps are the grant's lineage checks
 * (`require: 'one'`), so a later scan that took the gate refuses the whole batch with
 * `UNDO_SUPERSEDED` before any write. The actor is the request's own, checked by epochs.
 */
export function undoGrant(c: UndoCommit): Grant {
  const g = addUndoWrites(openUndoGrant(c), c);
  if (c.occupancy) addOccupancyUndo(g, c, c.occupancy);
  return g;
}

export async function commitUndo(c: UndoCommit): Promise<D1Result[]> {
  const { presence } = c;
  const { writes: results, after } = await undoGrant(c).commitWith(c.reads ?? []);
  // A grant that passed wrote every row; a short result means the batch contract broke after commit.
  const rows = (index: number) => results[index]?.results?.length ?? 0;
  if (
    rows(0) !== 1 ||
    rows(1) !== 1 ||
    rows(2) !== 1 ||
    rows(3) !== 1 ||
    (presence && rows(5) !== 1)
  )
    throw new AppError('UNDO_UNCONFIRMED', 500, 'The undo could not be confirmed.');
  return after;
}
