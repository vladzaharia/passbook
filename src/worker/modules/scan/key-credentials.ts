import { bump } from '../../platform/counters.ts';
import { ForbiddenError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import type { KeyAdminAuthority } from './repo-admin-grant.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Per key: a credential call is one that makes a secret. The one-call setup keeps its own, lower count. */
export const CREDENTIAL_CALLS = { counter: 'scan-cred:calls', limit: 60 } as const;
export const SETUP_CALLS = { counter: 'scan-setup:calls', limit: 10 } as const;
/** PINs, codes and tokens a key makes in a day, across the setup and the credential routes. */
const SECRETS_PER_DAY = 100;

/**
 * The key that may make door credentials in this org: a live `scanning:admin` key bound to it, acting
 * as itself. Platform keys (no org), test keys, other orgs and other scopes are all refused.
 */
export function credentialKeyOf(
  authority: TenantPassWrite | null | undefined,
  orgId: string,
  actorId: string,
  scope: 'scanning:admin',
): KeyAdminAuthority {
  if (
    authority?.kind !== 'api_key' ||
    authority.scope !== scope ||
    authority.keyOrgId !== orgId ||
    authority.orgId !== orgId ||
    authority.mode !== 'live' ||
    authority.keyId !== actorId
  )
    throw new ForbiddenError();
  return authority;
}

const window = (now: number, ms: number) => Math.floor(now / ms) * ms;

/**
 * Charges a key's budgets before the call runs: its credential calls an hour and its secrets a day.
 * Over a limit the charge is returned and the call is 429. The returned function refunds the charge
 * when nothing committed (a 4xx, a lost race); call it on every failure before the commit. A console
 * session has no budget here.
 */
export async function chargeSecrets(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  secrets: number,
  calls: { counter: string; limit: number } = CREDENTIAL_CALLS,
): Promise<() => Promise<void>> {
  if (authority.kind !== 'api_key' || secrets === 0) return async () => {};
  const now = ctx.clock.now();
  const [hour, day] = [window(now, HOUR), window(now, DAY)];
  const callsKey = `${calls.counter}:${authority.keyId}`;
  const secretsKey = `scan-setup:secrets:${authority.keyId}`;
  const refund = async () => {
    await bump(ctx.env.DB, callsKey, hour, -1);
    await bump(ctx.env.DB, secretsKey, day, -secrets);
  };
  const used = await bump(ctx.env.DB, callsKey, hour);
  const today = await bump(ctx.env.DB, secretsKey, day, secrets);
  if (used > calls.limit || today > SECRETS_PER_DAY) {
    await refund();
    // Retry-After names the window that tripped: the hour for calls, the day for the secrets.
    const retry = used > calls.limit ? hour + HOUR - now : day + DAY - now;
    throw new RateLimitedError(Math.max(1, Math.ceil(retry / 1000)));
  }
  return refund;
}

/** `run` under a charge for `secrets` (see `chargeSecrets`): a call that throws costs nothing. */
export async function charged<T>(
  ctx: ServiceContext,
  authority: TenantPassWrite,
  secrets: number,
  run: () => Promise<T>,
): Promise<T> {
  const refund = await chargeSecrets(ctx, authority, secrets);
  try {
    return await run();
  } catch (error) {
    await refund();
    throw error;
  }
}
