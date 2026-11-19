import { bump, read } from '../../platform/counters.ts';
import { ConflictError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from './http.ts';
import { getPassForWrite } from './pass-access.ts';
import { publishPass } from './publish.ts';
import type { ScopeArg } from './scope.ts';
import type { Actor } from './service.ts';

/** Refuses when the pass is at its New code limit for this hour; also counted by "replace codes". */
export async function assertNewCodeAllowed(ctx: ServiceContext, passId: string): Promise<void> {
  const now = ctx.clock.now();
  const window = now - (now % HOUR);
  if ((await read(ctx.env.DB, `passes:newcode:${passId}`, window)) >= NEW_CODES_PER_HOUR)
    throw new RateLimitedError(Math.ceil((window + HOUR - now) / 1000));
}

/** Counts a New code issued outside `newPassCode` (a channel replace) against the same hourly limit. */
export async function countNewCode(ctx: ServiceContext, passId: string): Promise<void> {
  const now = ctx.clock.now();
  await bump(ctx.env.DB, `passes:newcode:${passId}`, now - (now % HOUR));
}

const causeOf = (actor: Actor) => (actor.type === 'api_key' ? 'api' : 'admin');
const HOUR = 3_600_000;
export const NEW_CODES_PER_HOUR = 3;

/**
 * Mints a new scan code for the pass in place and republishes it: same serial, token and holder, so
 * the holder's Wallet updates itself and a copy of the old barcode stops scanning. The audit row
 * never carries a code.
 */
export async function newPassCode(
  ctx: ServiceContext,
  actor: Actor,
  passId: string,
  scope: ScopeArg,
  authority?: TenantPassWrite,
): Promise<void> {
  const pass = await getPassForWrite(ctx.env.DB, passId, scope);
  if (pass.removedAt !== null || pass.status !== 'active')
    throw new ConflictError('Only an active pass can get a new code.', 'PASS_NOT_ACTIVE');
  const now = ctx.clock.now();
  const window = now - (now % HOUR);
  const key = `passes:newcode:${pass.id}`;
  if ((await read(ctx.env.DB, key, window)) >= NEW_CODES_PER_HOUR)
    throw new RateLimitedError(Math.ceil((window + HOUR - now) / 1000));
  await publishPass(ctx, {
    passId,
    orgScope: scope,
    cause: causeOf(actor),
    actor,
    force: true,
    rotateScanCode: true,
    ...(authority ? { authority } : {}),
    transferPendingError: () =>
      new ConflictError(
        'A holder transfer is pending. Try again after it finishes.',
        'PASS_CONFLICT',
      ),
  });
  await bump(ctx.env.DB, key, window);
}
