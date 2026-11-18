import type { ScanTag } from '../../../shared/contracts/nfc-tags.ts';
import type { ScanCodeInput, ScanOutcome, ScanReason } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tagRef } from '../nfc/tag-ref.ts';
import type { ScanActor } from './actor.ts';
import type { CountsRead } from './counts.ts';
import { grantReadMiss } from './misses.ts';
import { blankOutcome } from './outcome.ts';
import { tagStateStmt, unknownTagWindow } from './repo-tags-resolve.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';

/** What `act` needs from a tag read: its reads ride the first batch, then it names the pass. */
export interface TagAct {
  /** The keyed ref of the tag: the request hash names it, never the UID. */
  ref: string;
  stmts: D1PreparedStatement[];
  /** The tag's reads, and the pass a replayed key already acted on, to the pass to act on or the answer. */
  choose(
    results: readonly D1Result[],
    replayed: string | null,
  ): Promise<{ actor: ScanActor; input: ScanCodeInput } | ScanOutcome>;
}

const NO_COUNTS: CountsRead = {
  approvals: false,
  counts: { today: 0, event: null, asOf: 0, configRev: 0 },
};

/** A tag refused before any pass: no card, no pass, no scan row. */
export const tagRefusal = (reason: ScanReason, read: CountsRead = NO_COUNTS): ScanOutcome => ({
  ...blankOutcome('refused', read),
  reason,
});

/** A read that names no tag the org has, in either mode: a pass code in its NDEF keeps today's path. */
export async function tagUnknown(ctx: ServiceContext, actor: ScanActor, uid: string) {
  const other = actor.mode === 'live' ? 'test' : 'live';
  const [own, theirs] = await Promise.all([
    tagRef(ctx.env, actor.orgId, actor.mode, uid),
    tagRef(ctx.env, actor.orgId, other, uid),
  ]);
  const [a, b] = await ctx.env.DB.batch([
    tagStateStmt(ctx.env.DB, actor.orgId, actor.mode, own.ref),
    tagStateStmt(ctx.env.DB, actor.orgId, other, theirs.ref),
  ]);
  return !a?.results?.length && !b?.results?.length;
}

/** An unknown tag is a miss on the actor's counter, while the tag is still unknown. */
export async function countTagMiss(ctx: ServiceContext, actor: ScanActor, ref: string) {
  const unchanged = unknownTagWindow(ref);
  if ((await grantReadMiss(ctx, actor, { refs: [], unchanged })) !== 'counted')
    ctx.log.info('scan.tag_miss_uncounted', { orgId: actor.orgId, code: 'SCAN_MISS_UNCOUNTED' });
}

/** The tag rides an answer about the chosen pass, never a masked one or a replay. Hub rows never carry it. */
export function withTagView(result: ScanEvaluation, view: ScanTag | null): ScanEvaluation {
  const outcome = result.outcome;
  if (!view || outcome.replay || outcome.reason === 'not_found') return result;
  return { ...result, outcome: { ...outcome, tag: view } };
}
