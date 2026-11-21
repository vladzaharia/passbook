import type { AppEnv } from '../../platform/env.ts';
import { createSafeFetch, platformHostsOf, type SafeFetch } from '../../platform/safe-fetch.ts';

/** What Google issuer and key work reaches outside for. Tests replace both with `setManagedDeps`. */
export interface ManagedDeps {
  /** Wallet API and OAuth calls. */
  fetcher: () => typeof fetch;
  /** IAM calls go through safe-fetch (https, public hosts, capped). */
  iam: (env: AppEnv) => SafeFetch;
  /** Pause between a new key's first uses: Google needs seconds before it signs. */
  wait: (ms: number) => Promise<void>;
}

const real: ManagedDeps = {
  fetcher: () => globalThis.fetch,
  iam: (env) => createSafeFetch({ platformHosts: platformHostsOf(env), timeoutMs: 10_000 }),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let current: ManagedDeps = real;

export const managedDeps = (): ManagedDeps => current;

/** Test seam: pass nothing to restore. */
export function setManagedDeps(next?: Partial<ManagedDeps>): void {
  current = next ? { ...real, ...next } : real;
}
