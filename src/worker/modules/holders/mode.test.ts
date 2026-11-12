import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { createPassRow } from '../passes/create.ts';
import { type Kit, setupKit } from '../passes/pass-test-fixtures.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { setupTenantTestAuth, type TenantTestAuth } from '../passes/tenant-test-fixtures.ts';

const ORIGIN = 'https://wallet.test';
let auth: TenantTestAuth;
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

const post = (path: string, headers: Record<string, string>, body: unknown) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
const livePass = () =>
  createPassRow(jobCtxOf(kit), {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: kit.liveRelease!.version,
    releaseId: kit.liveRelease!.id,
    releaseGeneration: kit.liveRelease!.generation,
    input: { memberName: 'Live holder' },
    holderEmail: 'live-holder@example.com',
    source: 'manual',
    execution: { kind: 'system' },
    mode: 'live',
    actor: { type: 'system', id: null },
  });

const WRITES: [string, string, (id: string) => unknown][] = [
  ['assign', '/holders/assign', (passId) => ({ passId, email: 'new@example.com' })],
  [
    'assign-bulk',
    '/holders/assign-bulk',
    (passId) => ({ items: [{ passId, email: 'new@example.com' }] }),
  ],
  ['reassign', '/holders/reassign', (passId) => ({ passId, email: 'new@example.com' })],
  ['unassign', '/holders/unassign', (passId) => ({ passId })],
  ['clear-block', '/holders/clear-block', (passId) => ({ passId, userId: 'u1' })],
];

describe('holder writes cannot cross modes', () => {
  it.each(WRITES)('a test key gets 404 for a live pass: %s', async (_n, path, body) => {
    const pass = await livePass();
    const res = await post(
      path,
      await auth.apiKey({ orgId: kit.org.id, mode: 'test', scopes: ['holders:write'] }),
      body(pass.id),
    );
    expect(res.status).toBe(404);
    expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBe('live-holder@example.com');
  });

  it.each(WRITES)(
    'a Test-mode session gets 409 MODE_MISMATCH for a live pass: %s',
    async (_n, path, body) => {
      const pass = await livePass();
      const res = await post(path, auth.admin({ mode: 'test' }), body(pass.id));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('MODE_MISMATCH');
      expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBe('live-holder@example.com');
    },
  );

  it('a live key still reassigns a live pass', async () => {
    const pass = await livePass();
    const res = await post(
      '/holders/reassign',
      await auth.apiKey({ orgId: kit.org.id, scopes: ['holders:write'] }),
      {
        passId: pass.id,
        email: 'next@example.com',
      },
    );
    expect(res.status).toBe(200);
  });
});
