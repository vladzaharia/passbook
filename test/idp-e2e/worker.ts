import { PolarisBinding as RealBinding } from '../../workers/passbook-id-connector/src/index.ts';
import type { BindingEnv } from '../../workers/passbook-id-connector/src/types.ts';

/**
 * The real binding, with one change: the binding refuses any origin but https, and the e2e mock of Polaris ID listens on
 * http loopback. Calls to the pinned https origin go to the mock; the binding's own origin and route checks have already run.
 */
const E2E_ORIGIN = 'https://polaris.e2e.test';
let mock = '';
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  return realFetch(
    url.startsWith(E2E_ORIGIN) && mock ? mock + url.slice(E2E_ORIGIN.length) : input,
    init,
  );
}) as typeof fetch;

export class PolarisBinding extends RealBinding {
  constructor(ctx: ExecutionContext, env: BindingEnv & { MOCK_POLARIS_URL: string }) {
    super(ctx, env);
    mock = env.MOCK_POLARIS_URL;
  }
}

export default { fetch: () => new Response('Not found', { status: 404 }) };
