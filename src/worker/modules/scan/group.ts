import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import { AppError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { act } from './act.ts';
import type { ActRequestInput } from './act-claim.ts';
import type { ScanActor } from './guard.ts';
import {
  bundleOf,
  checkedInCount,
  GROUP_MAX,
  groupMembers,
  recordGroup,
  scanPassId,
} from './repo-group.ts';
import type { ScanEvaluation } from './scan-evaluation.ts';
import { statsFor } from './stats.ts';
import { undo } from './undo.ts';
import type { UndoRequest } from './undo-replay.ts';

type Member = NonNullable<NonNullable<ScanOutcome['group']>['members']>[number];

/** A member's key is derived from the group's, so a replayed group request replays every member. */
async function derivedKey(key: string, part: string): Promise<string> {
  const h = await sha256Hex(`${key}:${part}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function stateOf(o: ScanOutcome): Member['state'] {
  if (o.kind === 'ok') return 'done';
  return o.kind === 'heads_up' && o.reason === 'already_done' ? 'already' : 'refused';
}

const memberOf = (o: ScanOutcome): Member => ({
  name: o.card?.title ?? '',
  state: stateOf(o),
  reason: o.reason,
});

/** The pass a scan answered for: its card or snapshot, else the scan's own row. */
async function passIdOf(
  ctx: ServiceContext,
  actor: ScanActor,
  e: ScanEvaluation,
): Promise<string | null> {
  const known = e.outcome.card?.passId ?? e.evaluatedSnapshot?.pass.id;
  if (known) return known;
  if (!e.outcome.scanId) return null;
  return scanPassId(ctx.env.DB, actor.orgId, e.outcome.scanId);
}

/** The chip's data: the bundle behind the scanned pass, how many of it are in. Not on a refusal. */
export async function withBundle(
  ctx: ServiceContext,
  actor: ScanActor,
  e: ScanEvaluation,
): Promise<ScanOutcome> {
  const o = e.outcome;
  if (o.kind === 'refused') return o;
  const passId = await passIdOf(ctx, actor, e);
  const bundle = passId && (await bundleOf(ctx.env.DB, actor.orgId, actor.mode, passId));
  if (!bundle || bundle.passIds.length < 2) return o;
  const checkedIn = await checkedInCount(ctx.env.DB, actor, bundle.id, ctx.clock.now());
  const chip = { id: bundle.id, name: bundle.name, size: bundle.passIds.length, checkedIn };
  return { ...o, bundle: chip, ...(o.card ? { card: { ...o.card, bundle: chip } } : {}) };
}

/**
 * `group: 'bundle'`: the scanned pass runs the single-pass pipeline, then so does every other member
 * of its bundle (at most 10), each as its own scan under a key derived from this request's.
 */
export async function actGroup(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequestInput,
): Promise<ScanEvaluation> {
  const primary = await act(ctx, actor, req);
  const first = primary.outcome;
  const scanned = req.group === 'bundle' ? await passIdOf(ctx, actor, primary) : null;
  const bundle = scanned && (await bundleOf(ctx.env.DB, actor.orgId, actor.mode, scanned));
  if (!bundle) return primary;
  const outcomes = [first];
  for (const passId of bundle.passIds.filter((id) => id !== scanned)) {
    try {
      const member = await act(ctx, actor, {
        idempotencyKey: await derivedKey(req.idempotencyKey, passId),
        input: { passId, method: 'manual' },
        clientTs: req.clientTs,
        ...(req.dayStart === undefined ? {} : { dayStart: req.dayStart }),
        ...(req.scope ? { scope: req.scope } : {}),
        ...(req.direction ? { direction: req.direction } : {}),
        actionId: 'auto',
      });
      outcomes.push(member.outcome);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      ctx.log.warn('scan.group.member_failed', { orgId: actor.orgId, code: error.code });
      outcomes.push({ ...first, kind: 'refused', reason: 'stale', card: null });
    }
  }
  const members = outcomes.map(memberOf);
  const count = (s: Member['state']) => members.filter((m) => m.state === s).length;
  const group = {
    total: members.length,
    done: count('done'),
    already: count('already'),
    refused: count('refused'),
    members,
  };
  const made = outcomes.flatMap((o) => (o.kind === 'ok' && o.scanId ? [o.scanId] : []));
  if (first.scanId && made.length) await recordGroup(ctx.env.DB, actor.orgId, first.scanId, made);
  const done = outcomes.find((o) => o.kind === 'ok');
  const until = Math.max(0, ...outcomes.map((o) => (o.kind === 'ok' ? (o.undoUntil ?? 0) : 0)));
  const outcome: ScanOutcome = {
    ...(done ? { ...first, kind: 'ok', reason: null, action: done.action, flags: [] } : first),
    group,
    counts: await statsFor(ctx, actor, req.dayStart),
    undoUntil: done ? until : first.undoUntil,
  };
  return { ...primary, outcome };
}

/** Undo of a group request's scan reverses every member it made; any other scan undoes alone. */
export async function undoGroup(
  ctx: ServiceContext,
  actor: ScanActor,
  scanId: string,
  req: UndoRequest,
  maxAgeMs?: number,
): Promise<ScanEvaluation> {
  const ids = await groupMembers(ctx.env.DB, actor.orgId, scanId);
  if (!ids.length) return undo(ctx, actor, scanId, req, maxAgeMs);
  let last: ScanEvaluation | null = null;
  let failure: unknown = null;
  for (const id of ids.slice(0, GROUP_MAX)) {
    try {
      last = await undo(
        ctx,
        actor,
        id,
        { ...req, idempotencyKey: await derivedKey(req.idempotencyKey, id) },
        maxAgeMs,
      );
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      ctx.log.warn('scan.group.undo_skipped', { orgId: actor.orgId, code: error.code });
      failure ??= error;
    }
  }
  if (!last) throw failure;
  return last;
}
