import { bump } from '../../platform/counters.ts';
import { RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';

const CHANGES_PER_KEY_HOUR = 6;
const HOUR_MS = 60 * 60_000;

/** A key or a person starts at most six change runs an hour: each one rewrites and may notify many passes. */
export async function limitChanges(ctx: ServiceContext, authority: TenantPassWrite): Promise<void> {
  const now = ctx.clock.now();
  const window = Math.floor(now / HOUR_MS) * HOUR_MS;
  const who = authority.kind === 'session' ? `user:${authority.userId}` : `key:${authority.keyId}`;
  if ((await bump(ctx.env.DB, `change-run:${who}`, window)) > CHANGES_PER_KEY_HOUR)
    throw new RateLimitedError(Math.ceil((window + HOUR_MS - now) / 1000));
}
