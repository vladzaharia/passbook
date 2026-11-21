import { envString } from '../../platform/env.ts';
import { type DnsResolver, dohResolver } from '../../platform/safe-fetch.ts';

const TTL_MS = 60_000;
const MAX_HOSTS = 256;

const memo = new Map<string, { at: number; addresses: string[] }>();

/** For tests: the memo is per isolate. */
export function clearResolverMemo(): void {
  memo.clear();
}

/**
 * Caches answers per host for 60 s in the isolate, so a lane of 20 sends to one host resolves once.
 * Every answer is still checked by `createSafeFetch`, and a changed answer is seen within a minute.
 */
export function memoResolver(now: () => number, inner: DnsResolver = dohResolver()): DnsResolver {
  return {
    async resolve(host, signal) {
      const t = now();
      const hit = memo.get(host);
      if (hit && t - hit.at < TTL_MS) return hit.addresses;
      const addresses = await inner.resolve(host, signal);
      if (memo.size >= MAX_HOSTS) memo.clear();
      memo.set(host, { at: t, addresses });
      return addresses;
    },
  };
}

function plainHttpLoopback(value: string | undefined): boolean {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Local and e2e only: `WEBHOOK_TEST_DNS` ("host=1.2.3.4,other=5.6.7.8") answers those hosts without a
 * lookup, so the e2e can add and send to an endpoint with no network. It is honoured only when
 * `PUBLIC_BASE_URL` is plain-http loopback, which no production or preview-with-a-domain config is,
 * and the address still passes the private-range check in `assertPublicHost`.
 */
function pinned(env: object): DnsResolver | null {
  const raw = envString(env, 'WEBHOOK_TEST_DNS');
  if (!raw || !plainHttpLoopback(envString(env, 'PUBLIC_BASE_URL'))) return null;
  const table = new Map(
    raw.split(',').map((pair) => {
      const [host = '', address = ''] = pair.split('=');
      return [host.trim(), [address.trim()]] as [string, string[]];
    }),
  );
  return { resolve: async (host) => table.get(host) ?? [] };
}

/** The resolver for webhook URLs: the memoised DoH lookup, or the pinned test table when it applies. */
export function resolverFor(env: object, now: () => number): DnsResolver {
  const fixed = pinned(env);
  return fixed ?? memoResolver(now);
}
