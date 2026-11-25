import type { ServiceContext } from '../../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../../settings/repo.ts';
import { idpCodeOf } from '../errors.ts';
import { markDirty } from '../repo-dirty.ts';
import type { IdpRpc } from '../types.ts';
import { setupsOf } from './repo-resolve.ts';
import { type EndedSetup, endedSetups } from './repo-sweep.ts';

/** The ended time of the last invitation settled: the next run starts after it. */
const MARK = 'idp.invite_sweep';

const markOf = async (db: D1Database): Promise<number> => {
  const stored = await readSystemValue(db, MARK);
  return typeof stored === 'number' ? stored : 0;
};

/** Invitations the next sweep settles, oldest first. Two cheap reads, so the minute hook can ask every time. */
export async function dueSetups(ctx: ServiceContext, limit: number): Promise<EndedSetup[]> {
  const db = ctx.env.DB;
  return endedSetups(db, await markOf(db), ctx.clock.now(), limit);
}

/**
 * Settles invitations that ended with signup tokens out. `proveSignup` with no subject finds the accounts the
 * tokens made and records them as ours, so marking each dirty lets the drain take back what the tokens gave (the
 * desired state holds no reason for an invitation nobody accepted). Run again for the same invitation it finds the
 * same accounts and changes nothing. A definite refusal skips the invitation; anything else stops the run and
 * the next one starts at the same invitation.
 */
export async function sweepSetups(
  ctx: ServiceContext,
  rpc: Pick<IdpRpc, 'proveSignup'>,
  due: readonly EndedSetup[],
): Promise<void> {
  const db = ctx.env.DB;
  for (const item of due) {
    const ids = (await setupsOf(db, item.kind, item.id)).map((s) => s.idp_token_id);
    try {
      const proof = await rpc.proveSignup(ids);
      for (const subject of new Set(proof?.matches.map((m) => m.subject)))
        await markDirty(db, subject);
    } catch (error) {
      const code = idpCodeOf(error);
      ctx.log.warn('invitation.sweep_failed', { code: code ?? 'IDP_UNAVAILABLE', kind: item.kind });
      if (code !== 'IDP_REFUSED' && code !== 'IDP_CONFLICT') return;
    }
    await writeSystemValue(db, MARK, item.ended, ctx.clock.now());
  }
}
