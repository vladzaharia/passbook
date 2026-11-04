import type { AppEnv } from '../../platform/env.ts';
import { AppError } from '../../platform/errors.ts';
import { createLogger } from '../../platform/log.ts';
import { loadPushKey, teamHasPushKey } from '../identities/push-key-store.ts';
import { apnsToken, dropApnsToken } from './apns-jwt.ts';

export interface ApnsTarget {
  /** Pass Type ID, used as apns-topic. */
  passTypeIdentifier: string;
  /** Env binding name of the mTLS certificate (e.g. APNS). */
  apnsBinding: string | null;
  /** Apple team of the identity; selects the push key when there is no mTLS binding. */
  teamIdentifier?: string;
}

export type ApnsMethod = 'certificate' | 'key' | 'none';

export interface ApnsResult {
  token: string;
  status: number;
  /** APNs reason, e.g. BadDeviceToken, Unregistered, DeviceTokenNotForTopic. */
  reason?: string;
  apnsId?: string;
}

export interface ApnsTransport {
  /** False when the identity has neither an mTLS binding nor a team push key ("push unavailable"). */
  isAvailable(target: ApnsTarget): boolean | Promise<boolean>;
  /** One request per device token; never throws for per-device failures. */
  send(target: ApnsTarget, tokens: string[], now: number): Promise<ApnsResult[]>;
}

const APNS_HOST = 'https://api.push.apple.com';

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function pushOne(
  doFetch: Fetch,
  target: ApnsTarget,
  token: string,
  now: number,
  extra: Record<string, string> = {},
): Promise<ApnsResult> {
  try {
    const response = await doFetch(`${APNS_HOST}/3/device/${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: {
        'apns-topic': target.passTypeIdentifier,
        'apns-push-type': 'background',
        'apns-priority': '5',
        'apns-expiration': String(Math.floor(now / 1000) + 7 * 86400),
        'content-type': 'application/json',
        ...extra,
      },
      body: '{}',
    });
    const apnsId = response.headers.get('apns-id') ?? undefined;
    let reason: string | undefined;
    if (response.ok) await response.body?.cancel();
    else reason = ((await response.json().catch(() => ({}))) as { reason?: string }).reason;
    return {
      token,
      status: response.status,
      ...(reason ? { reason } : {}),
      ...(apnsId ? { apnsId } : {}),
    };
  } catch (error) {
    return {
      token,
      status: 0,
      reason: `NetworkError:${error instanceof Error ? error.name : 'unknown'}`,
    };
  }
}

/** Production APNs over the identity's mTLS binding. A missing binding means push is unavailable. */
export function createMtlsApnsTransport(env: AppEnv): ApnsTransport {
  const binding = (target: ApnsTarget): Fetcher | undefined =>
    target.apnsBinding
      ? (env as unknown as Record<string, Fetcher | undefined>)[target.apnsBinding]
      : undefined;
  return {
    isAvailable: (target) => binding(target) !== undefined,
    async send(target, tokens, now) {
      const fetcher = binding(target);
      if (!fetcher) return tokens.map((token) => ({ token, status: 0, reason: 'PushUnavailable' }));
      return Promise.all(
        tokens.map((token) => pushOne((u, i) => fetcher.fetch(u, i), target, token, now)),
      );
    },
  };
}

const bindingOf = (env: AppEnv, target: ApnsTarget): Fetcher | undefined =>
  target.apnsBinding
    ? (env as unknown as Record<string, Fetcher | undefined>)[target.apnsBinding]
    : undefined;

/** How this target would be pushed: its mTLS binding, else its team's push key, else not at all. */
export async function apnsMethod(env: AppEnv, target: ApnsTarget): Promise<ApnsMethod> {
  if (bindingOf(env, target)) return 'certificate';
  return (await teamHasPushKey(env, target.teamIdentifier ?? '')) ? 'key' : 'none';
}

/**
 * Token auth over plain fetch. APNs needs HTTP/2; if the runtime cannot negotiate it every
 * request fails before an answer, which is logged as APNS_TOKEN_TRANSPORT_FAILED.
 */
export function createKeyApnsTransport(env: AppEnv): ApnsTransport {
  const log = createLogger({ build: env.CF_VERSION?.id });
  return {
    isAvailable: async (target) => (await apnsMethod(env, target)) === 'key',
    async send(target, tokens, now) {
      const team = target.teamIdentifier ?? '';
      const unavailable = (reason: string) => tokens.map((token) => ({ token, status: 0, reason }));
      let key: Awaited<ReturnType<typeof loadPushKey>>;
      try {
        key = await loadPushKey(env, team);
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        log.error('apns.push_key_unreadable', { code: error.code, team });
        return unavailable('PushKeyUnreadable');
      }
      if (!key) return unavailable('PushUnavailable');
      const jwt = await apnsToken(team, key, now);
      const results = await Promise.all(
        tokens.map((token) =>
          pushOne((u, i) => fetch(u, i), target, token, now, { authorization: `bearer ${jwt}` }),
        ),
      );
      if (
        results.some(
          (r) => r.reason === 'ExpiredProviderToken' || r.reason === 'InvalidProviderToken',
        )
      )
        dropApnsToken(team, key.keyId);
      const unreached = results.filter(
        (r) => r.status === 0 && r.reason?.startsWith('NetworkError'),
      );
      if (unreached.length > 0)
        log.error('apns.token_transport_failed', {
          code: 'APNS_TOKEN_TRANSPORT_FAILED',
          team,
          devices: unreached.length,
          reason: unreached[0]?.reason,
        });
      return results;
    },
  };
}

/** The production transport: mTLS binding when the identity has one, else the team's push key. */
export function createApnsTransport(env: AppEnv): ApnsTransport {
  const mtls = createMtlsApnsTransport(env);
  const key = createKeyApnsTransport(env);
  return {
    async isAvailable(target) {
      return (await apnsMethod(env, target)) !== 'none';
    },
    async send(target, tokens, now) {
      return bindingOf(env, target)
        ? mtls.send(target, tokens, now)
        : key.send(target, tokens, now);
    },
  };
}
