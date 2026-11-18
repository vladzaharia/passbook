import type { ScanTag } from '../../../shared/contracts/nfc-tags.ts';
import type { ScanCodeInput, ScanOutcome, ScanReason } from '../../../shared/contracts/scan.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { tagRef } from '../nfc/tag-ref.ts';
import type { ScanActor } from './actor.ts';
import type { CountsRead } from './counts.ts';
import { grantReadMiss } from './misses.ts';
import { blankOutcome } from './outcome.ts';
import { missWindow } from './repo-miss-authority.ts';
import { tagStateStmt } from './repo-tags-resolve.ts';
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
  const unchanged = missWindow(
    'NOT EXISTS (SELECT 1 FROM nfc_tags t WHERE t.org_id = {org} AND t.mode = {mode} AND t.tag_ref = ?)',
    [ref],
  );
  if ((await grantReadMiss(ctx, actor, { refs: [], unchanged })) !== 'counted')
    ctx.log.info('scan.tag_miss_uncounted', { orgId: actor.orgId, code: 'SCAN_MISS_UNCOUNTED' });
}

/** The tag rides only an answer about a pass; a customer screen never gets it. */
export function withTagView(result: ScanEvaluation, view: ScanTag | null): ScanEvaluation {
  const outcome = result.outcome;
  if (!view || outcome.replay || (outcome.template === null && outcome.card === null))
    return result;
  return { ...result, outcome: { ...outcome, tag: view } };
}
