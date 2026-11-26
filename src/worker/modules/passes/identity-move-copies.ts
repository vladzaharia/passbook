import type { ServiceContext } from '../../platform/service-context.ts';
import { googleCopyHasUsers } from '../wallet-providers/google-copy-users.ts';
import type { MoveRow } from './repo-identity-move.ts';
import { unconfirmedGoogle } from './repo-identity-move-wallet.ts';

/** How long a wait that cost a Google read lasts before the row asks again. */
export const ASK_AGAIN_MS = 60 * 60_000;

/**
 * A Google copy no report speaks of may still be saved: a callback can be lost. Google is asked whether the
 * object has users. `empty` clears the copy for the void; `users` holds it, and so does an answer that cannot be
 * had. Samsung has no such read, so its copy stays held until the replacement's is saved. `null` when there is
 * nothing to ask.
 */
export async function askGoogle(
  ctx: ServiceContext,
  row: MoveRow,
): Promise<'empty' | 'users' | 'unknown' | null> {
  if (!(await unconfirmedGoogle(ctx.env.DB, row))) return null;
  const users = await googleCopyHasUsers(ctx, {
    id: row.old_pass_id,
    orgId: row.org_id,
    mode: row.mode,
  });
  if (users === null) {
    ctx.log.warn('identity_move.google_unread', {
      code: 'IDENTITY_MOVE_GOOGLE_UNREAD',
      moveId: row.id,
    });
    return 'unknown';
  }
  return users ? 'users' : 'empty';
}
