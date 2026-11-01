import type { AppEnv } from '../../platform/env.ts';
import type { Logger } from '../../platform/log.ts';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Fail closed: any network, parse or protocol problem is a failed check, and is logged. */
export async function verifyTurnstile(
  env: Pick<AppEnv, 'TURNSTILE_SECRET'>,
  token: string,
  ip: string | null,
  log: Logger,
  fetchImpl: typeof fetch = fetch,
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
    const result = (await res.json()) as { success?: unknown };
    return result.success === true;
  } catch (error) {
    log.warn('auth.turnstile_unavailable', {
      code: 'TURNSTILE_UNAVAILABLE',
      error: error instanceof Error ? error.name : 'unknown',
    });
    return false;
  }
}
