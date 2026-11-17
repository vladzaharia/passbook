import type { ServiceContext } from '../../platform/service-context.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import type { ScanActor } from './guard.ts';
import { prepareReadMiss } from './misses.ts';

/** Count a confirmed read-only miss without credential input in its own transaction. */
export async function countMiss(ctx: ServiceContext, actor: ScanActor): Promise<void> {
  const csrf = await actorCsrfFence(ctx, actor);
  if (!csrf) return;
  const credentials =
    actor.credentialKeysetCommitment === undefined
      ? null
      : {
          credentialKeysetCommitment: actor.credentialKeysetCommitment,
          credentialTombstoneRefs: [],
        };
  const plan = prepareReadMiss(ctx, actor, {
    csrf,
    credentials,
    candidates: { sql: '0', params: [] },
    visible: [],
  });
  const results = await ctx.env.DB.batch(plan.stmts);
  plan.throwIfCapped(plan.result(results));
}
