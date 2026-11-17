import type { Grant } from '../../platform/authority.ts';
import { AppError } from '../../platform/errors.ts';
import { addUndoWrites, openUndoGrant, type UndoCommit } from './repo-undo-grant.ts';

export {
  UNDO_CODES,
  type UndoCommit,
  type UndoGate,
  type UndoPresence,
} from './repo-undo-grant.ts';

/**
 * One batch. The gate, presence and target compare-and-swaps are the grant's lineage checks
 * (`require: 'one'`), so a later scan that took the gate refuses the whole batch with
 * `UNDO_SUPERSEDED` before any write. The actor is the request's own, checked by epochs.
 */
export function undoGrant(c: UndoCommit): Grant {
  return addUndoWrites(openUndoGrant(c), c);
}

export async function commitUndo(c: UndoCommit): Promise<void> {
  const { presence } = c;
  const results = await undoGrant(c).commit();
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
}
