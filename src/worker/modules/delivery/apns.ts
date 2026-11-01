import type { AppEnv } from '../../platform/env.ts';

export interface ApnsTarget {
  /** Pass Type ID, used as apns-topic. */
  passTypeIdentifier: string;
  /** Env binding name of the mTLS certificate (e.g. APNS). */
  apnsBinding: string | null;
}

export interface ApnsResult {
  token: string;
  status: number;
  /** APNs reason, e.g. BadDeviceToken, Unregistered, DeviceTokenNotForTopic. */
  reason?: string;
  apnsId?: string;
}

export interface ApnsTransport {
  /** False when no mTLS binding exists for the identity ("push unavailable"). */
  isAvailable(target: ApnsTarget): boolean;
  /** One request per device token; never throws for per-device failures. */
  send(target: ApnsTarget, tokens: string[], now: number): Promise<ApnsResult[]>;
}

const APNS_HOST = 'https://api.push.apple.com';

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
        tokens.map(async (token): Promise<ApnsResult> => {
          try {
            const response = await fetcher.fetch(
              `${APNS_HOST}/3/device/${encodeURIComponent(token)}`,
              {
                method: 'POST',
                headers: {
                  'apns-topic': target.passTypeIdentifier,
                  'apns-push-type': 'background',
                  'apns-priority': '5',
                  'apns-expiration': String(Math.floor(now / 1000) + 7 * 86400),
                  'content-type': 'application/json',
                },
                body: '{}',
              },
            );
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
        }),
      );
    },
  };
}
