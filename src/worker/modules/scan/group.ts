import type { ScanCodeInput, ScanOutcome } from '../../../shared/contracts/scan.ts';
import { AppError, ValidationError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { act } from './act.ts';
import type { ActRequestInput } from './act-claim.ts';
import type { ScanActor } from './guard.ts';
import { publishScan } from './live.ts';
import {
  bundleOf,
  checkedInCount,
  GROUP_MAX,
  groupMembers,
  livePassIds,
  recordGroup,
  scanPassId,
} from './repo-group.ts';
import { scanByKey } from './repo-scans.ts';
import { resolveOutcome } from './resolve-outcome.ts';
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
  return o.kind === 'heads_up' && (o.reason === 'already_done' || o.reason === 'still_inside')
    ? 'already'
    : 'refused';
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

type Step = { outcome: ScanOutcome; scanId: string | null; evaluation: ScanEvaluation | null };

const refusedWith = (o: ScanOutcome, reason: ScanOutcome['reason']): ScanOutcome => ({
  ...o,
  kind: 'refused',
  reason,
});

/**
 * `group: 'bundle'`: every pass of the scanned pass's bundle (at most 10, the scanned one first) is
 * checked in, never anything else: each is read first, skipped when already in, then runs the
 * single-pass pipeline as an entry under a key derived from this request's.
 */
export async function actGroup(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequestInput,
): Promise<ScanEvaluation> {
  if (req.group !== 'bundle' || 'tag' in req.input) return act(ctx, actor, req);
  if (actor.settings.direction === 'out')
    throw new ValidationError('Check in all is for entry scanners.', [], 'GROUP_ENTRY_ONLY');
  const input = req.input;
  const read = (i: ScanCodeInput, part: string) =>
    derivedKey(req.idempotencyKey, part).then((idempotencyKey) =>
      resolveOutcome(ctx, actor, {
        idempotencyKey,
        input: i,
        clientTs: req.clientTs,
        ...(req.dayStart === undefined ? {} : { dayStart: req.dayStart }),
        ...(req.scope ? { scope: req.scope } : {}),
      }),
    );
  const scannedRead = await read(input, 'scanned');
  const scanned = scannedRead.outcome.card?.passId ?? scannedRead.evaluatedSnapshot?.pass.id;
  const bundle = scanned && (await bundleOf(ctx.env.DB, actor.orgId, actor.mode, scanned));
  if (!bundle) return act(ctx, actor, req);
  const order = [scanned, ...bundle.passIds.filter((id) => id !== scanned)];
  const live = await livePassIds(ctx.env.DB, actor, order, ctx.clock.now());
  const steps: Step[] = [];
  let anchor: string | null = null;
  for (const passId of order) {
    const step = await member(
      ctx,
      actor,
      req,
      passId,
      live,
      passId === scanned ? scannedRead : null,
      scannedRead.outcome,
    );
    steps.push(step);
    if (step.scanId && step.outcome.kind === 'ok') {
      anchor ??= step.scanId;
      await recordGroup(ctx.env.DB, actor.orgId, anchor, [step.scanId]);
      if (step.evaluation)
        publishScan(
          ctx,
          actor,
          step.outcome,
          step.evaluation.evaluatedSnapshot,
          step.evaluation.credentialContext,
          'manual',
        );
    }
  }
  const members = steps.map((s) => memberOf(s.outcome));
  const count = (st: Member['state']) => members.filter((m) => m.state === st).length;
  const group = {
    total: members.length,
    done: count('done'),
    already: count('already'),
    refused: count('refused'),
    members,
  };
  const head = steps[0] as Step;
  const made = steps.filter((s) => s.outcome.kind === 'ok');
  const admitted = members[0]?.state === 'done' || members[0]?.state === 'already';
  const base = !admitted
    ? head.outcome
    : made.length
      ? { ...(made[0] as Step).outcome, card: null, flags: [] }
      : { ...head.outcome, kind: 'heads_up' as const, reason: 'already_done' as const };
  const until = Math.max(0, ...made.map((s) => s.outcome.undoUntil ?? 0));
  const outcome: ScanOutcome = {
    ...base,
    scanId: anchor ?? base.scanId,
    group,
    counts: await statsFor(ctx, actor, req.dayStart),
    undoUntil: anchor ? until : base.undoUntil,
  };
  return { ...scannedRead, outcome };
}

/** One member: read, skip when in, else check in under its own key (a manager's PIN only if it asks). */
async function member(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequestInput,
  passId: string,
  live: Set<string>,
  known: ScanEvaluation | null,
  fallback: ScanOutcome,
): Promise<Step> {
  const key = await derivedKey(req.idempotencyKey, passId);
  const approvedKey = await derivedKey(req.idempotencyKey, `${passId}:approved`);
  try {
    const read =
      known ??
      (await resolveOutcome(ctx, actor, {
        idempotencyKey: await derivedKey(req.idempotencyKey, `${passId}:read`),
        input: { passId, method: 'manual' },
        clientTs: req.clientTs,
        ...(req.dayStart === undefined ? {} : { dayStart: req.dayStart }),
        ...(req.scope ? { scope: req.scope } : {}),
      }));
    const approvedRow = await scanByKey(ctx.env.DB, actor.actorKey, approvedKey);
    const prior = approvedRow ?? (await scanByKey(ctx.env.DB, actor.actorKey, key));
    const body = (idempotencyKey: string, actionId: string) => ({
      idempotencyKey,
      input: { passId, method: 'manual' as const },
      clientTs: req.clientTs,
      ...(req.dayStart === undefined ? {} : { dayStart: req.dayStart }),
      ...(req.scope ? { scope: req.scope } : {}),
      direction: 'in' as const,
      actionId,
    });
    if (prior?.actionId) {
      // A replayed group: the member's own receipt, not a fresh decision.
      const e = await act(ctx, actor, {
        ...body(approvedRow ? approvedKey : key, prior.actionId),
        ...(approvedRow && req.approval ? { approval: req.approval } : {}),
      });
      return { outcome: e.outcome, scanId: e.outcome.scanId, evaluation: null };
    }
    const o = read.outcome;
    if (o.kind !== 'ready' || !o.card) return { outcome: o, scanId: null, evaluation: null };
    if (live.has(passId))
      return {
        outcome: { ...o, kind: 'heads_up', reason: 'already_done' },
        scanId: null,
        evaluation: null,
      };
    const entry = o.card.actions.find((a) => a.kind === 'check_in');
    const asks = entry?.lock === 'approval';
    if (!entry || (!entry.available && !(asks && req.approval)))
      return {
        outcome: refusedWith(o, entry?.reason ?? (asks ? 'needs_approval' : 'not_accepted')),
        scanId: null,
        evaluation: null,
      };
    let e = await act(ctx, actor, body(key, entry.id));
    if (req.approval && e.outcome.reason === 'needs_approval')
      e = await act(ctx, actor, { ...body(approvedKey, entry.id), approval: req.approval });
    return { outcome: e.outcome, scanId: e.outcome.scanId, evaluation: e };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.status === 401 || error.status === 403 || error.code === 'SCAN_UNCONFIRMED')
      throw error;
    ctx.log.warn('scan.group.member_failed', { orgId: actor.orgId, code: error.code });
    const retry = error.code === 'SCAN_IN_PROGRESS';
    return {
      outcome: {
        ...(known?.outcome ?? fallback),
        kind: retry ? 'heads_up' : 'refused',
        reason: retry ? 'in_progress' : 'stale',
        card: null,
      },
      scanId: null,
      evaluation: null,
    };
  }
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
      if (last) publishUndone(ctx, actor, last);
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

/** Each member's undo reaches the live feed; the route publishes the last one it gets back. */
function publishUndone(ctx: ServiceContext, actor: ScanActor, e: ScanEvaluation) {
  publishScan(ctx, actor, e.outcome, e.evaluatedSnapshot, e.credentialContext, 'manual', true);
}
