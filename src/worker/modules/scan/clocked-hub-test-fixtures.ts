import type { Mode } from '../../../shared/contracts/common.ts';
import type { ManualClock } from '../../platform/clock.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { scanHub } from './live.ts';
import type { LiveRingRow } from './live-ring.ts';

type Hub = ReturnType<typeof scanHub>;

/** The live hub reads its caller's clock from `now`; tests pass the kit clock so it never reads wall time. */
export function clockedHub(ctx: ServiceContext, clock: ManualClock, orgId: string, mode: Mode) {
  const hub = scanHub(ctx, orgId, mode);
  return {
    stub: hub,
    fetch: (request: Request) => {
      const stamped = new Request(request);
      stamped.headers.set('x-pb-now', String(clock.now()));
      return hub.fetch(stamped);
    },
    kick: (scannerId: string) => hub.kick(scannerId),
    publish: (input: Parameters<Hub['publish']>[0]) => hub.publish({ now: clock.now(), ...input }),
    snapshot: (
      attachment: Parameters<Hub['snapshot']>[0],
      after?: string | null,
      now = clock.now(),
    ) => hub.snapshot(attachment, after, now),
    ringRow: (eventId: string): Promise<LiveRingRow | null> => hub.ringRow(eventId, clock.now()),
  };
}
