import { envString } from '../../platform/env.ts';

const PROVIDER_ORIGINS = new Set([
  'https://oauth2.googleapis.com',
  // Google's callback signing keys (google-callback-crypto.ts); the save page is the same origin.
  'https://pay.google.com',
  'https://walletobjects.googleapis.com',
  'https://tsapi-card.walletsvc.samsung.com',
]);

function loopbackHttp(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    return url.protocol === 'http:' && local && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** The mock's URL when it and `PUBLIC_BASE_URL` are both plain-http loopback (dev and e2e), else null. */
export function mockProvidersUrl(env: object): URL | null {
  const mock = loopbackHttp(envString(env, 'WALLET_MOCK_PROVIDERS_URL'));
  return mock && loopbackHttp(envString(env, 'PUBLIC_BASE_URL')) ? mock : null;
}

/**
 * Dev and e2e only: with `WALLET_MOCK_PROVIDERS_URL` (test/mock-wallets) set, provider calls go to
 * the local fake. Both it and `PUBLIC_BASE_URL` must be plain-http loopback, so no production
 * configuration (https origin, never a declared var) can redirect a call. Fences still see the
 * real provider URL; only the outgoing request moves.
 */
export function mockProviderInput(env: object, input: RequestInfo | URL): RequestInfo | URL {
  const mock = mockProvidersUrl(env);
  if (!mock) return input;
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!PROVIDER_ORIGINS.has(url.origin)) return input;
  const target = `${mock.origin}${url.pathname}${url.search}`;
  return input instanceof Request ? new Request(target, input) : target;
}

/**
 * `fetch` through `mockProviderInput`, for provider calls made outside runtime-core (credential checks,
 * Samsung card reads). Outside dev and e2e it is `fetch` unchanged.
 */
export function providerFetch(env: object): typeof fetch {
  return (input, init) => globalThis.fetch(mockProviderInput(env, input), init);
}
