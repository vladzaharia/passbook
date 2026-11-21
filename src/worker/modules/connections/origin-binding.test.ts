import { afterEach, beforeEach, expect, it } from 'vitest';
import * as actions from './actions.ts';
import { resetDeps, setDeps } from './deps.ts';
import * as service from './service.ts';
import { demoInput, type Kit, makeKit } from './test-kit.ts';

let kit: Kit;
const seen: { url: string; auth: string | null }[] = [];
beforeEach(async () => {
  kit = await makeKit();
  seen.length = 0;
  setDeps({
    resolver: { resolve: async () => ['93.184.216.34'] },
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response('{"id":"x"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
});
afterEach(() => resetDeps());

const cfg = (baseUrl: string) => ({ baseUrl, testRef: 'm1', auth: { type: 'bearer' } });

async function make() {
  return service.create(
    kit.sctx,
    kit.actor,
    demoInput(kit, {
      connectorType: 'http-json',
      name: 'Members API',
      config: cfg('https://api.example.com/v1'),
      secrets: { token: 'tok-owner-entered-secret' },
    } as never),
  );
}

it('refuses an origin change without a new credential, and never sends the secret', async () => {
  const dto = await make();
  await expect(
    service.update(kit.sctx, kit.actor, dto.id, { config: cfg('https://attacker.example/v1') }),
  ).rejects.toMatchObject({ code: 'VALIDATION', issues: [{ path: 'secrets' }] });
  await actions.test(kit.sctx, kit.actor, dto.id);
  expect(seen.some((s) => s.url.startsWith('https://attacker.example/'))).toBe(false);
});

it('refuses a sibling host as a new origin', async () => {
  const dto = await make();
  await expect(
    service.update(kit.sctx, kit.actor, dto.id, { config: cfg('https://api2.example.com/v1') }),
  ).rejects.toMatchObject({ code: 'VALIDATION' });
});

it('allows a path change on the same origin without a credential', async () => {
  const dto = await make();
  await service.update(kit.sctx, kit.actor, dto.id, { config: cfg('https://api.example.com/v2') });
});

it('allows an origin change with a new credential in the same request', async () => {
  const dto = await make();
  await service.update(kit.sctx, kit.actor, dto.id, {
    config: cfg('https://other.example/v1'),
    secrets: { token: 'tok-new' },
  });
  await actions.test(kit.sctx, kit.actor, dto.id);
  expect(seen.find((s) => s.url.startsWith('https://other.example/'))?.auth).toBe('Bearer tok-new');
});
