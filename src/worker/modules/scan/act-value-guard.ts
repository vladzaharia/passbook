import type { ScanCard, ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { activeRelease } from '../templates/releases.ts';
import type { ActRequest } from './act-claim.ts';
import { finishStop, type StopContext } from './act-stop.ts';
import { scanValueOf } from './act-value-result.ts';
import { localDayStart } from './counts.ts';
import { amountOf, ScanEffectStop, schemaOf, valueEffect } from './effects-value.ts';
import type { ScanActor } from './guard.ts';
import type { StopAuthority } from './repo-action-authority.ts';
import { amountUsedSince } from './repo-scan-amount.ts';
import type { Found, Stop } from './resolve.ts';
import { resolveOutcome } from './resolve-outcome.ts';

/**
 * The maximum of a release waiting to reissue the pass, when it is lower than the pass's own: an
 * add never takes the count above what the next version accepts.
 */
export async function pendingCap(
  ctx: ServiceContext,
  found: Found,
  action: ResolvedScanAction,
): Promise<number | undefined> {
  if (action.kind !== 'add' || !action.input) return undefined;
  const { pass } = found;
  const head = await activeRelease(ctx, pass.templateId, pass.orgId, pass.mode, 'apple');
  if (!head || head.version === pass.templateVersion) return undefined;
  try {
    const next = await resolveTemplate(ctx, pass.orgId, pass.templateId, head.version);
    const max = schemaOf(next.manifest, action.input)?.maximum;
    return typeof max === 'number' ? max : undefined;
  } catch (error) {
    if (error instanceof AppError) return undefined;
    throw error;
  }
}

/**
 * What stops a value action before anything is reserved or written: a connection's input, the
 * scanner's daily amount, a balance that is short or a card that is full. Null when it can apply.
 */
export async function valueRefusal(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  action: ResolvedScanAction,
  req: ActRequest,
): Promise<ScanEffectStop | null> {
  const { pass } = found;
  if (action.input && pass.fieldSources[action.input] === 'connection' && !action.allowOnConnected)
    return new ScanEffectStop('managed_elsewhere');
  const limit = actor.settings.dailyAmount;
  if (limit != null && (action.kind === 'add' || action.kind === 'take')) {
    const used = await amountUsedSince(
      ctx.env.DB,
      actor,
      localDayStart(ctx.clock.now(), actor.timeZone),
    );
    if (used + amountOf(action, req.amount) > limit) return new ScanEffectStop('limit_reached');
  }
  try {
    valueEffect(
      action,
      found.template.manifest,
      pass,
      { amount: req.amount, value: req.value },
      await pendingCap(ctx, found, action),
    );
    return null;
  } catch (error) {
    if (error instanceof ScanEffectStop) return error;
    throw error;
  }
}

/** The card as it stands now, read like a resolve (no scan row). Null when it cannot be read. */
async function freshCard(
  ctx: ServiceContext,
  actor: ScanActor,
  req: ActRequest,
): Promise<ScanCard | null> {
  try {
    const { outcome } = await resolveOutcome(ctx, actor, {
      idempotencyKey: req.idempotencyKey,
      input: req.input,
      clientTs: req.clientTs,
      ...(req.dayStart !== undefined ? { dayStart: req.dayStart } : {}),
      ...(req.scope ? { scope: req.scope } : {}),
    });
    return outcome.kind === 'ready' ? outcome.card : null;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.warn('scan.fresh_card_failed', { code: error.code });
    return null;
  }
}

/** Close the claimed scan with the stop: a refusal, or the heads-up of a card that moved (with the card it is now). */
export async function finishEffectStop(
  s: StopContext,
  found: Found,
  action: ResolvedScanAction,
  stop: ScanEffectStop,
  authority: StopAuthority,
  req: ActRequest,
): Promise<ScanOutcome> {
  const reason = stop.reason;
  const refusal: Stop = {
    stop: true,
    kind: reason === 'stale' ? 'heads_up' : 'refused',
    reason,
    pass: found.pass,
    ref: found.ref,
    at: null,
    flags: [],
    found,
    hard: true,
  };
  const have =
    stop.have === null ? null : scanValueOf(found, s.actor, action, stop.have, stop.have);
  const outcome = await finishStop(s, refusal, authority);
  const card = reason === 'stale' ? await freshCard(s.ctx, s.actor, req) : null;
  return { ...outcome, value: have, ...(card ? { card } : {}) };
}
