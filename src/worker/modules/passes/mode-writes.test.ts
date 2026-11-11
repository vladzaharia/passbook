import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { first } from '../../platform/db.ts';
import { createPassRow } from './create.ts';
import { getPass } from './repo.ts';
import { type Kit, setupKit } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
});

type Headers = Record<string, string>;
const call = (method: string, path: string, headers: Headers, body: unknown = {}) =>
  app.request(
    `${ORIGIN}/api/v1${path}`,
    {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      ...(method === 'GET' || method === 'DELETE' ? {} : { body: JSON.stringify(body) }),
    },
    kit.env,
  );
const make = (mode: 'live' | 'test', holderEmail = 'holder@example.com') =>
  createPassRow(kit.ctx, {
    orgId: kit.org.id,
    templateId: kit.template.id,
    templateVersion: kit.template.version,
    input: { memberName: `Mode ${mode}` },
    holderEmail,
    source: 'manual',
    mode,
    actor: { type: 'system', id: null },
  });
const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

const WRITES: [string, string, (id: string) => string, unknown?][] = [
  ['PATCH', 'update', (id) => `/passes/${id}`, { input: { memberName: 'Changed' } }],
  ['POST', 'void', (id) => `/passes/${id}/void`],
  ['POST', 'unvoid', (id) => `/passes/${id}/unvoid`],
  ['POST', 'remove', (id) => `/passes/${id}/remove`],
  ['POST', 'restore', (id) => `/passes/${id}/restore`],
  ['POST', 'refresh', (id) => `/passes/${id}/refresh`],
  ['POST', 'rotate-link', (id) => `/passes/${id}/rotate-link`],
  ['POST', 'resend-email', (id) => `/passes/${id}/resend-email`],
  ['DELETE', 'delete', (id) => `/passes/${id}`],
  ['PUT', 'bind', (id) => `/passes/${id}/connection`, { connectionId: null, externalRef: null }],
];

describe('by-id writes cannot cross modes', () => {
  it.each(WRITES)(
    'a test API key gets 404 for a live pass: %s %s',
    async (method, _n, path, body) => {
      const live = await make('live');
      const res = await call(method, path(live.id), fake.apiKey({ mode: 'test' }), body);
      expect(res.status).toBe(404);
      expect(await getPass(kit.env.DB, live.id)).toMatchObject({
        version: live.version,
        status: 'active',
      });
    },
  );

  it.each(WRITES)(
    'a Test-mode session gets 409 MODE_MISMATCH for a live pass: %s %s',
    async (method, _n, path, body) => {
      const live = await make('live');
      const res = await call(method, path(live.id), fake.admin({ mode: 'test' }), body);
      expect(res.status).toBe(409);
      expect(await codeOf(res)).toBe('MODE_MISMATCH');
    },
  );

  it('the message names the mode to switch to', async () => {
    const live = await make('live');
    const res = await call('POST', `/passes/${live.id}/void`, fake.admin({ mode: 'test' }));
    expect(((await res.json()) as { detail?: string; message?: string }).detail).toBe(
      'This pass is live. Switch to Live mode to change it.',
    );
  });

  it('a live session still writes live passes and reads test ones', async () => {
    const live = await make('live');
    expect((await call('POST', `/passes/${live.id}/void`, fake.admin())).status).toBe(200);
    const test = await make('test');
    expect((await call('GET', `/passes/${test.id}`, fake.admin())).status).toBe(200);
    expect((await call('GET', `/passes/${test.id}/events`, fake.admin())).status).toBe(200);
  });

  it('a test key cannot read the events or devices of a live pass', async () => {
    const live = await make('live');
    const key = fake.apiKey({ mode: 'test' });
    expect((await call('GET', `/passes/${live.id}/events`, key)).status).toBe(404);
    expect((await call('GET', `/passes/${live.id}/devices`, key)).status).toBe(404);
  });

  it('the email is not queued by a refused resend', async () => {
    const live = await make('live');
    await call('POST', `/passes/${live.id}/resend-email`, fake.apiKey({ mode: 'test' }));
    expect(
      await first(kit.env.DB, "SELECT 1 AS x FROM outbox WHERE pass_id = ? AND kind = 'email'", [
        live.id,
      ]),
    ).toBeNull();
  });
});

describe('bulk actions skip the other mode', () => {
  it('reports other-mode ids and acts on the rest', async () => {
    const live = await make('live');
    const test = await make('test');
    const res = await call('POST', '/passes/bulk', fake.admin({ mode: 'test' }), {
      action: 'void',
      ids: [live.id, test.id],
      orgId: kit.org.id,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      done: 1,
      skipped: [{ id: live.id, code: 'MODE_MISMATCH' }],
    });
    expect((await getPass(kit.env.DB, live.id))?.status).toBe('active');
    expect((await getPass(kit.env.DB, test.id))?.status).toBe('voided');
  });

  it('refuses a selection that spans organizations', async () => {
    const elsewhere = await makeOrg(kit.fx, { name: 'Elsewhere' });
    const mine = await make('live');
    const theirs = await createPassRow(kit.ctx, {
      orgId: elsewhere.id,
      templateId: kit.template.id,
      templateVersion: kit.template.version,
      input: { memberName: 'Theirs' },
      source: 'manual',
      mode: 'live',
      actor: { type: 'system', id: null },
    });
    const res = await call('POST', '/passes/bulk', fake.admin(), {
      action: 'void',
      ids: [mine.id, theirs.id],
    });
    expect(res.status).toBe(422);
    expect(await codeOf(res)).toBe('ORG_MIXED');
    expect((await getPass(kit.env.DB, mine.id))?.status).toBe('active');
  });

  it('send_email skips removed passes', async () => {
    const pass = await make('live');
    await call('POST', `/passes/${pass.id}/remove`, fake.admin());
    const res = await call('POST', '/passes/bulk', fake.admin(), {
      action: 'send_email',
      ids: [pass.id],
      orgId: kit.org.id,
    });
    expect(await res.json()).toEqual({ done: 0, skipped: [{ id: pass.id, code: 'PASS_REMOVED' }] });
  });
});

describe('resend', () => {
  it('refuses a removed pass', async () => {
    const pass = await make('live');
    await call('POST', `/passes/${pass.id}/remove`, fake.admin());
    const res = await call('POST', `/passes/${pass.id}/resend-email`, fake.admin());
    expect(res.status).toBe(409);
    expect(await codeOf(res)).toBe('PASS_REMOVED');
  });
});
