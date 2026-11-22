import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type SdkRig, setupSdkRig } from './sdk-test-kit.ts';

// The examples in sdk/typescript/examples build their own client, so they reach the test world
// through a stubbed global fetch. Their types are checked by sdk/typescript/tsconfig.examples.json.
let rig: SdkRig;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  rig = await setupSdkRig();
});
afterEach(() => {
  vi.unstubAllEnvs();
  globalThis.fetch = realFetch;
});

function useTestWorld() {
  vi.stubEnv('PASSBOOK_KEY', rig.key);
  vi.stubEnv('PASSBOOK_TEMPLATE_ID', rig.kit.template.id);
  // The example's sample fields are not the test template's; send the template's own.
  globalThis.fetch = (input, init) =>
    rig.toApp(
      input,
      init?.method === 'POST' && typeof init.body === 'string'
        ? {
            ...init,
            body: JSON.stringify({
              ...JSON.parse(init.body),
              input: { memberName: 'Ada Example' },
            }),
          }
        : init,
    );
}

describe('sdk examples', () => {
  it('passes-create issues a pass, then passes-list pages through it', async () => {
    useTestWorld();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.resetModules();
    await import('../../sdk/typescript/examples/passes-create.ts');
    const [id] = log.mock.calls[0] ?? [];
    expect(id).toEqual(expect.any(String));
    await import('../../sdk/typescript/examples/passes-list.ts');
    expect(log.mock.calls.some(([listed]) => listed === id)).toBe(true);
    log.mockRestore();
  });

  it('webhooks-verify answers 400 to an unsigned body', async () => {
    vi.stubEnv('PASSBOOK_WEBHOOK_SECRET', 'whsec_test');
    const { handle } = await import('../../sdk/typescript/examples/webhooks-verify.ts');
    const res = await handle(new Request('https://hooks.test/in', { method: 'POST', body: '{}' }));
    expect(res.status).toBe(400);
  });
});
