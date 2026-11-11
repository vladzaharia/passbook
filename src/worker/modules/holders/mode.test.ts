import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { createPassRow } from '../passes/create.ts';
import { getPass } from '../passes/repo.ts';
import { type Kit, setupKit } from '../passes/test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
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
  createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: kit.template.version,
    input: { memberName: 'Live holder' },
    holderEmail: 'live-holder@example.com',
    source: 'manual',
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
      fake.apiKey({ mode: 'test', scopes: ['holders:write'] }),
      body(pass.id),
    );
    expect(res.status).toBe(404);
    expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBe('live-holder@example.com');
  });

  it.each(WRITES)(
    'a Test-mode session gets 409 MODE_MISMATCH for a live pass: %s',
    async (_n, path, body) => {
      const pass = await livePass();
      const res = await post(path, fake.admin({ mode: 'test' }), body(pass.id));
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe('MODE_MISMATCH');
      expect((await getPass(kit.env.DB, pass.id))?.holderEmail).toBe('live-holder@example.com');
    },
  );

  it('a live key still reassigns a live pass', async () => {
    const pass = await livePass();
    const res = await post('/holders/reassign', fake.apiKey({ scopes: ['holders:write'] }), {
      passId: pass.id,
      email: 'next@example.com',
    });
    expect(res.status).toBe(200);
  });
});
