import { ConflictError } from '../../../platform/errors.ts';
import type { ServiceContext } from '../../../platform/service-context.ts';
import { readSystemValue, writeSystemValue } from '../../settings/repo.ts';
import { idpCodeOf } from '../errors.ts';
import { markDirty } from '../repo-dirty.ts';
import type { IdpRpc } from '../types.ts';
import { acceptPlatformSubject, grantPlatformGroups } from './platform-accept.ts';
import { platformInviteOf } from './platform-resolve.ts';
import { platformById } from './repo-platform.ts';
import { setupsOf } from './repo-resolve.ts';
import {
  type Cursor,
  type EndedSetup,
  type ExpiredToken,
  endedSetups,
  expiredTokens,
} from './repo-sweep.ts';

/** Where the two sweeps stopped: system values holding a `Cursor`. */
const ENDED_MARK = 'idp.invite_sweep';
const TOKEN_MARK = 'idp.invite_token_sweep';

async function cursorOf(db: D1Database, name: string): Promise<Cursor> {
  const stored = (await readSystemValue(db, name)) as Partial<Cursor> | number | null;
  if (typeof stored === 'number') return { at: stored, key: '\uffff' };
  return typeof stored?.at === 'number' && typeof stored.key === 'string'
    ? { at: stored.at, key: stored.key }
    : { at: 0, key: '' };
}

export interface DueSweeps {
  ended: EndedSetup[];
  tokens: ExpiredToken[];
}

/** What the next sweep settles, oldest first. A few cheap reads, so the minute hook can ask every time. */
export async function dueSweeps(ctx: ServiceContext, limit: number): Promise<DueSweeps> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  return {
    ended: await endedSetups(db, await cursorOf(db, ENDED_MARK), now, limit),
    tokens: await expiredTokens(db, await cursorOf(db, TOKEN_MARK), now, limit),
  };
}

/** A platform invitation still open whose token proved the invited address: accepted here, unless it needs a sign-in. */
async function acceptSweptPlatform(
  ctx: ServiceContext,
  invitationId: string,
  subject: string,
): Promise<void> {
  const row = await platformById(ctx.env.DB, invitationId, ctx.clock.now());
  const invite = row ? platformInviteOf(row, ctx.clock.now()) : null;
  if (invite?.state !== 'pending' || invite.developer) return;
  try {
    await grantPlatformGroups(ctx, invite, subject);
    await acceptPlatformSubject(ctx, invite, subject, null);
  } catch (error) {
    // A lost race (revoked or accepted meanwhile) settles nothing here; anything else stops the run like a binding failure.
    if (!(error instanceof ConflictError)) throw error;
    ctx.log.warn('invitation.sweep_failed', { code: 'INVITATION_CONFLICT', what: 'platform' });
  }
}

/** A definite refusal skips the item; anything else stops the run, and the next one starts at the same item. */
function stopsRun(ctx: ServiceContext, error: unknown, what: string): boolean {
  const code = idpCodeOf(error);
  ctx.log.warn('invitation.sweep_failed', { code: code ?? 'IDP_UNAVAILABLE', what });
  return code !== 'IDP_REFUSED' && code !== 'IDP_CONFLICT';
}

/**
 * Settles what the invitations left in Polaris ID. `proveSignup` finds the accounts a token made and records them
 * as ours, so marking each dirty lets the drain take back what the token gave: the desired state holds no reason for
 * an account nobody accepted, and keeps the groups of whoever has a membership or sponsorship.
 * - A token that expired for another address than the invitation's: that account can never accept; settled at once.
 *   A platform invitation's token that expired for the invited address finishes the invitation (no sign-in is
 *   needed without developer access), so a person who created their Polaris ID and never pressed Done still joins.
 * - An invitation that ended (revoked, accepted, or past its window) and whose last token expired: every account its
 *   tokens made, so a stranger's token used after the real invitee accepted is found too.
 * Repeating either for the same item finds the same accounts and changes nothing.
 */
export async function sweepSetups(
  ctx: ServiceContext,
  rpc: Pick<IdpRpc, 'proveSignup'>,
  due: DueSweeps,
): Promise<void> {
  const db = ctx.env.DB;
  for (const token of due.tokens) {
    try {
      const proof = await rpc.proveSignup([token.token_id], { email: token.email });
      if (proof?.emailMatch === 'mismatch') await markDirty(db, proof.subject);
      if (proof?.emailMatch === 'match' && token.kind === 'platform')
        await acceptSweptPlatform(ctx, token.invitation_id, proof.subject);
    } catch (error) {
      if (stopsRun(ctx, error, 'token')) break;
    }
    await writeSystemValue(
      db,
      TOKEN_MARK,
      { at: token.due, key: token.token_id } satisfies Cursor,
      ctx.clock.now(),
    );
  }
  for (const item of due.ended) {
    const ids = (await setupsOf(db, item.kind, item.id)).map((s) => s.idp_token_id);
    try {
      const proof = await rpc.proveSignup(ids);
      for (const subject of new Set(proof?.matches.map((m) => m.subject)))
        await markDirty(db, subject);
    } catch (error) {
      if (stopsRun(ctx, error, item.kind)) return;
    }
    await writeSystemValue(
      db,
      ENDED_MARK,
      { at: item.ended, key: `${item.kind}:${item.id}` } satisfies Cursor,
      ctx.clock.now(),
    );
  }
}
