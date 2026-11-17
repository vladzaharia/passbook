import { claimOf } from './act-claim.ts';
import type { ScanActor } from './actor.ts';
import type { Claim } from './repo-scans.ts';
import type { ScanKit } from './test-kit.ts';

/** The claim a request of this actor would open, for fence shapes that name it. */
export function claimOfCorpus(kit: ScanKit, actor: ScanActor): Claim {
  return claimOf(
    kit.ctx,
    actor,
    {
      idempotencyKey: 'corpus-key',
      input: { code: 'corpus', method: 'camera' },
      clientTs: kit.clock.now(),
      actionId: 'check_in',
    } as never,
    'scan-1',
    'hash-1',
  );
}
