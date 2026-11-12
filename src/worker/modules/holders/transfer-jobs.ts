import type { ServiceContext } from '../../platform/service-context.ts';
import {
  saveTransferResumeCursor,
  transferResumeCursor,
} from '../passes/repo-credential-transfer-read.ts';
import { listSweepWaitingPasses, waitingHolderSweepUpper } from './repo.ts';
import { runAttachHookA } from './service.ts';

/** Retry every eligible waiting holder, including after reissue or a completed transfer. */
export async function resumeVerifiedHolderAttachments(ctx: ServiceContext): Promise<void> {
  const limit = 40;
  const stored = await transferResumeCursor(ctx.env.DB, 'attach');
  const upper = stored.upper ?? (await waitingHolderSweepUpper(ctx.env.DB));
  if (upper === null) return;
  const waiting = await listSweepWaitingPasses(ctx.env.DB, { ...stored, upper }, limit);
  const last = waiting[waiting.length - 1];
  const next =
    waiting.length === limit && last ? { after: last.id, upper } : { after: null, upper: null };
  await saveTransferResumeCursor(ctx.env.DB, next, ctx.clock.now(), 'attach');
  for (const row of waiting) {
    try {
      await runAttachHookA(ctx, row.id);
    } catch (error) {
      ctx.log.error('pass.transfer_attach_failed', {
        passId: row.id,
        code: 'TRANSFER_ATTACH',
        error,
      });
    }
  }
}
