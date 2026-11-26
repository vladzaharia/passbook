import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { progressOf } from '../operations/progress.ts';
import type { StepHandle } from '../operations/progress-types.ts';
import type { Totals } from './records.ts';

type Ids = { operationId?: string | undefined; operationAttempt?: number | undefined };

/**
 * What a sync tells its operation (a user's Sync now; scheduled and webhook runs have none, and every call is
 * then a no-op). The Workflow replays this code after each sleep, which is harmless: a step already done stays
 * done and counts only go up.
 */
export function syncReport(sctx: ServiceContext, p: Ids) {
  const progress = progressOf(sctx, p.operationId, p.operationAttempt ?? 1);
  const start = progress.step('start');
  let records: StepHandle | undefined;
  return {
    /** The run began: the checks passed and the first records are next. */
    began: async () => {
      await start.done();
      records = progress.step('records');
    },
    seen: (totals: Totals) => void records?.count(totals.seen),
    /** The listing ended; the result is saved next. */
    saving: async () => {
      await records?.done();
      return progress.step('save');
    },
    /** The run is closed: its outcome is the operation's. */
    ended: async (o: { failed: boolean; stale: boolean; totals: Totals }) => {
      if (o.failed)
        await progress.fail(
          new AppError('CONNECTION_SYNC_FAILED', 502, 'The sync did not finish.'),
        );
      else if (o.stale)
        await progress.fail(new AppError('CONNECTION_SYNC_STALE', 409, 'The connection changed.'));
      else
        await progress.succeed({
          href: null,
          ids: {
            seen: String(o.totals.seen),
            created: String(o.totals.created),
            changed: String(o.totals.changed),
            errors: String(o.totals.errors),
          },
        });
    },
    fail: (error: unknown) => progress.fail(error),
  };
}
