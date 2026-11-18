import { TURNSTILE_ACTION } from '../../../shared/turnstile.ts';
import type { AppEnv } from '../../platform/env.ts';
import type { Logger } from '../../platform/log.ts';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
/** Cloudflare's always-pass test secret answers with hostname example.com; deploy:check refuses it. */
const TEST_SECRET = '1x0000000000000000000000000000000AA';

/** Fail closed: any network, parse or protocol problem is a failed check, and is logged. */
export async function verifyTurnstile(
  env: Pick<AppEnv, 'TURNSTILE_SECRET' | 'PUBLIC_BASE_URL'>,
  token: string,
  ip: string | null,
  log: Logger,
  fetchImpl: typeof fetch = fetch,
  action: string = TURNSTILE_ACTION,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) {
    log.error('auth.turnstile_unconfigured', { code: 'TURNSTILE_UNCONFIGURED' });
    return false;
  }
  const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: token });
  if (ip && ip !== 'unknown') body.set('remoteip', ip);
  try {
    const res = await fetchImpl(VERIFY_URL, {
      method: 'POST',
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log.warn('auth.turnstile_unavailable', { code: 'TURNSTILE_UNAVAILABLE', status: res.status });
      return false;
    }
    const result = (await res.json()) as {
      success?: unknown;
      hostname?: unknown;
      action?: unknown;
    };
    if (result.success !== true) return false;
    if (env.TURNSTILE_SECRET === TEST_SECRET) return true;
    // A token solved on another site that shares this widget must not pass here.
    const expected = new URL(env.PUBLIC_BASE_URL).hostname.toLowerCase();
    if (typeof result.hostname !== 'string' || result.hostname.toLowerCase() !== expected) {
      log.warn('auth.turnstile_hostname', { code: 'TURNSTILE_HOSTNAME' });
      return false;
    }
    // A token minted for another widget action (another form on the same site key) is refused.
    if (result.action !== action) {
      log.warn('auth.turnstile_action', { code: 'TURNSTILE_ACTION' });
      return false;
    }
    return true;
  } catch (error) {
    log.warn('auth.turnstile_unavailable', {
      code: 'TURNSTILE_UNAVAILABLE',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}
