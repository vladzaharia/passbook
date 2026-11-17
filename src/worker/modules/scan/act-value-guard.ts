import type { ScanOutcome } from '../../../shared/contracts/scan.ts';
import type { ResolvedScanAction } from '../../../shared/scan-defaults.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { ActRequest } from './act-claim.ts';
import { finishStop, type StopContext } from './act-stop.ts';
import { scanValueOf } from './act-value-result.ts';
import { localDayStart } from './counts.ts';
import { amountOf, ScanEffectStop, valueEffect } from './effects-value.ts';
import type { ScanActor } from './guard.ts';
import type { StopAuthority } from './repo-action-authority.ts';
import { amountUsedSince } from './repo-scan-amount.ts';
import type { Found, Stop } from './resolve.ts';

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
    valueEffect(action, found.template.manifest, pass, { amount: req.amount, value: req.value });
    return null;
  } catch (error) {
    if (error instanceof ScanEffectStop) return error;
    throw error;
  }
}

/** Close the claimed scan with the stop: a refusal, or the heads-up of a card that moved. */
export function finishEffectStop(
  s: StopContext,
  found: Found,
  action: ResolvedScanAction,
  stop: ScanEffectStop,
  authority: StopAuthority,
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
  return finishStop(s, refusal, authority).then((outcome) => ({ ...outcome, value: have }));
}
