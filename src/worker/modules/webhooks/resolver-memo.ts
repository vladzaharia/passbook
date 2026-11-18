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
