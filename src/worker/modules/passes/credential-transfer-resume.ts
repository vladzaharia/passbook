import type { ServiceContext } from '../../platform/service-context.ts';
import { finishCredentialTransfer } from './credential-transfer.ts';
import {
  listPendingCredentialTransfers,
  saveTransferResumeCursor,
  transferResumeCursor,
  transferSweepUpper,
} from './repo-credential-transfer-read.ts';

/** Bounded round-robin: a permanently blocked transfer cannot starve later pending transfers. */
export async function resumePendingCredentialTransfers(ctx: ServiceContext): Promise<void> {
  const limit = 40;
  const cursor = await transferResumeCursor(ctx.env.DB, 'pending');
  cursor.upper ??= await transferSweepUpper(ctx.env.DB);
  if (cursor.upper === null) return;
  const rows = await listPendingCredentialTransfers(ctx.env.DB, cursor, limit);
  await saveTransferResumeCursor(
    ctx.env.DB,
    rows.length === limit
      ? { after: rows.at(-1)?.id ?? null, upper: cursor.upper }
      : { after: null, upper: null },
    ctx.clock.now(),
    'pending',
  );
  for (const row of rows) {
    try {
      await finishCredentialTransfer(ctx, row.id);
    } catch (error) {
      ctx.log.error('pass.transfer_resume_failed', {
        transferId: row.id,
        code: 'TRANSFER_RETRY',
        error,
      });
    }
  }
}
