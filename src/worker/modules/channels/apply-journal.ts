import type { ServiceContext } from '../../platform/service-context.ts';
import { recordPassEvents } from '../events/record.ts';
import { recordedEvents, unjournaled } from './repo-apply.ts';
import { writeJournaled } from './repo-apply-write.ts';
import type { ApplyRun } from './repo-runs.ts';

const ACTOR = { type: 'system', id: 'channel-apply' } as const;

/**
 * Sends the events of marks not yet journaled to the ledger, then marks them. A crash between the two
 * leaves the marks open; the replay skips the events already recorded, so none is written twice.
 */
export async function journal(ctx: ServiceContext, run: ApplyRun): Promise<void> {
  const pending = await unjournaled(ctx.env.DB, run.id);
  if (pending.length === 0) return;
  const done = await recordedEvents(
    ctx.env.DB,
    run.id,
    pending.map((m) => m.passId),
  );
  await recordPassEvents(
    ctx,
    pending.flatMap((m) =>
      m.events
        .filter((e) => !done.has(`${m.passId}:${e.channel}`))
        .map((data) => ({
          orgId: run.orgId,
          passId: m.passId,
          mode: run.mode,
          kind: 'pass.channels_changed' as const,
          actor: ACTOR,
          data,
        })),
    ),
  );
  await writeJournaled(
    ctx,
    run,
    pending.map((m) => m.passId),
  );
}
