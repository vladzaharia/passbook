import { PassBook } from '../../sdk/typescript/src/index.ts';
import { createApp } from '../../src/worker/app.ts';
import { setupKit } from '../../src/worker/modules/passes/pass-test-fixtures.ts';
import { makeTenantTestApiKey } from '../../src/worker/modules/passes/repo-tenant-test-fixtures.ts';
import { setupTenantTestAuth } from '../../src/worker/modules/passes/tenant-test-fixtures.ts';

type Fetch = typeof fetch;

export interface SdkRig {
  kit: Awaited<ReturnType<typeof setupKit>>;
  /** The SDK's calls reach the app in-process; `through` can answer or fail a call first. */
  client(options?: {
    through?: (call: Fetch) => Fetch;
    maxRetries?: number;
  }): Promise<{ pb: PassBook; calls: Request[] }>;
}

/** An app with real API-key auth and a client whose `fetch` is the app, with a test key. */
export async function setupSdkRig(): Promise<SdkRig> {
  const kit = await setupKit();
  const auth = await setupTenantTestAuth(kit);
  const app = createApp({ stores: auth.stores, clock: kit.clock });
  const key = await makeTenantTestApiKey(kit.fx, {
    orgId: kit.org.id,
    scopes: ['passes:read', 'passes:write'],
    mode: 'test',
  });
  const toApp: Fetch = async (input, init) => app.request(input as string, init, kit.env);
  return {
    kit,
    async client({ through, maxRetries } = {}) {
      const calls: Request[] = [];
      const recording: Fetch = (input, init) => {
        calls.push(new Request(input as string, init));
        return toApp(input, init);
      };
      const pb = new PassBook({
        apiKey: key.secret,
        baseUrl: 'https://wallet.test',
        fetch: through ? through(recording) : recording,
        retryDelayMs: 1,
        ...(maxRetries === undefined ? {} : { maxRetries }),
      });
      return { pb, calls };
    },
  };
}
