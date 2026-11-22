import { validityOf } from '../../../shared/pass-view/validity.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type AccessReads, accessStop, isGuestPass } from './access.ts';
import type { ScanActor } from './guard.ts';
import type { Candidate } from './repo-lookup.ts';
import type { Found, Stop } from './resolve.ts';
import { candidateAudit, candidateWallet } from './resolve-candidates.ts';
import type { ChannelVerdict } from './resolve-channels.ts';
import { stop } from './resolve-policy.ts';

/** Why a pass cannot be scanned at all, from the candidate alone. */
export function unavailable(ctx: ServiceContext, one: Candidate, exitAllowed = false): Stop {
  const json = candidateWallet(one);
  if (!json) return stop('refused', 'not_found', { stale: true });
  const audit = candidateAudit(one);
  const more = exitAllowed ? { exitAllowed: true } : {};
  if (one.pass.removedAt !== null)
    return stop('refused', 'removed', { ...audit, at: one.pass.removedAt });
  if (one.pass.status === 'voided')
    return stop('refused', 'voided', { ...audit, ...more, at: one.pass.modifiedAt });
  const validity = validityOf(json, ctx.clock.now());
  if (validity.status === 'voided')
    return stop('refused', 'voided', { ...audit, ...more, at: one.pass.modifiedAt });
  if (validity.status === 'expired')
    return stop('refused', isGuestPass(one) ? 'guest_expired' : 'expired', {
      ...audit,
      ...more,
      at: validity.validUntil,
    });
  return stop('refused', 'not_accepted');
}

/** Only a scanner that can tap out asks for a voided or ended pass back (OC4). */
export function mayExit(actor: ScanActor, one: Candidate): boolean {
  const dir = actor.settings.direction;
  return (
    dir === 'out' ||
    dir === 'both' ||
    actor.settings.checkIn?.mode === 'in_out' ||
    one.checkInRules?.mode === 'in_out'
  );
}

/**
 * OC4: leaving is never refused for who you are, so a voided or ended pass still taps out (steps
 * 10-14 do not apply). Only a caller that will commit the exit (`commits`) gets it; every other
 * read keeps today's refusal, with `exitAllowed` when the pass is inside and could tap out.
 */
export function exitGate(
  ctx: ServiceContext,
  one: Candidate,
  at: { exiting: boolean; inside: boolean; commits: boolean; channel: ChannelVerdict },
): Stop | null {
  if (!at.exiting) return unavailable(ctx, one);
  if (!at.commits) return unavailable(ctx, one, at.inside);
  if (at.channel?.kind === 'off')
    return stop('refused', 'channel_off', { ...candidateAudit(one), channel: at.channel.channel });
  return null;
}

/** An Access card on hold still taps out; the scan records that it did (the verdict is not applied). */
export function suspendedOf(
  ctx: ServiceContext,
  actor: ScanActor,
  found: Found,
  known: Pick<Stop, 'pass' | 'ref' | 'found' | 'connectionGeneration'>,
  reads: AccessReads | null,
  now: number,
): boolean {
  const { access } = found;
  const verdict = accessStop(ctx, actor, found, known, reads, now);
  if (access) found.access = access;
  else delete found.access;
  return verdict?.reason === 'suspended';
}
