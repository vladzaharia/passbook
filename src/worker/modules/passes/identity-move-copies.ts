import { IDENTITY_MOVE_COPY as COPY } from '../../../shared/copy/identity-move.ts';
import { notice } from '../../email/org-closed.ts';
import { baseUrl } from '../../platform/env.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { googleCopyHasUsers } from '../wallet-providers/google-copy-users.ts';
import { depsOf } from './deps.ts';
import { linksOf } from './detail.ts';
import type { MoveRow } from './repo-identity-move.ts';
import { claimWalletReminder, unclaimWalletReminder } from './repo-identity-move-timers.ts';
import { unconfirmedGoogle } from './repo-identity-move-wallet.ts';
import { getOrg } from './repo-read-issuance.ts';
import { getPass } from './repo-read-pass.ts';

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

const WALLET_NAMES: Record<string, string> = { google: 'Google Wallet', samsung: 'Samsung Wallet' };

/**
 * The 30-day reminder of a row that waits on a wallet copy: the existing reminder mail, naming the wallets
 * whose new pass is not saved. It goes once; the row keeps waiting, so a save after it still counts. `retry` when it could not be sent: the row tries again tomorrow.
 */
export async function remindWalletCopy(
  ctx: ServiceContext,
  row: MoveRow,
  reason: string,
): Promise<'sent' | 'skipped' | 'retry'> {
  const db = ctx.env.DB;
  if (!(await claimWalletReminder(db, row.id, ctx.clock.now()))) return 'skipped';
  const made = await getPass(db, row.new_pass_id, row.org_id);
  if (!made?.holderEmail) return 'skipped';
  try {
    const wallets = reason
      .slice(reason.indexOf(':') + 1)
      .split('+')
      .map((p) => WALLET_NAMES[p] ?? p)
      .join(' and ');
    const org = await getOrg(db, row.org_id);
    const url = (await linksOf(ctx, made)).publicUrl;
    const mail = notice(
      baseUrl(ctx.env),
      COPY.reminderSubject,
      COPY.reminderWalletBody(org?.name ?? null, url, wallets),
    );
    await depsOf(ctx.env).mailer.send({ to: made.holderEmail, ...mail });
    return 'sent';
  } catch {
    // Provider errors can carry message content: the code and the row are enough.
    ctx.log.error('identity_move.reminder_failed', {
      code: 'IDENTITY_MOVE_REMINDER',
      moveId: row.id,
    });
    await unclaimWalletReminder(db, row.id, ctx.clock.now());
    return 'retry';
  }
}
