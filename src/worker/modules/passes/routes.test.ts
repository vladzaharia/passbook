import { beforeAll, describe, expect, it } from 'vitest';
import { fakeAuth, makeOrg } from '../../../../test/helpers/index.ts';
import { PassDetailSchema, PassListSchema } from '../../../shared/contracts/index.ts';
import { createApp } from '../../app.ts';
import { all, first } from '../../platform/db.ts';
import { getPass, type Pass } from './repo.ts';
import { type Kit, setupKit, ICON_PNG } from './test-kit.ts';

const ORIGIN = 'https://wallet.test';
const fake = fakeAuth(ORIGIN);
let kit: Kit;
let app: ReturnType<typeof createApp>;
let orgB: { id: string };

beforeAll(async () => {
  kit = await setupKit();
  app = createApp({ stores: fake.stores });
  orgB = await makeOrg(kit.fx, { name: 'Other Org' });
});

type Headers = Record<string, string>;
const api = (path: string, init: RequestInit & { headers?: Headers } = {}) =>
  app.request(`${ORIGIN}/api/v1${path}`, init, kit.env);
const json = (
  headers: Headers,
  body: unknown,
  method = 'POST',
): RequestInit & { headers: Headers } => ({
  method,
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const create = (headers: Headers, input: Record<string, unknown> = {}, extra: Headers = {}) =>
  api('/passes', {
    ...json(
      { ...headers, ...extra },
      {
        orgId: kit.org.id,
        templateId: kit.template.id,
        input: { memberName: 'Api Member' },
        ...input,
      },
    ),
  });

describe('authentication', () => {
  it('rejects anonymous callers, plain users and keys without the scope', async () => {
    const pass = await kit.pass();
    expect((await api('/passes')).status).toBe(401);
    expect((await api('/passes', { headers: fake.user() })).status).toBe(403);
    expect(
      (await api(`/passes/${pass.id}`, { headers: fake.apiKey({ scopes: ['templates:read'] }) }))
        .status,
    ).toBe(403);
    const readOnly = fake.apiKey({ scopes: ['passes:read'] });
    expect((await api(`/passes/${pass.id}`, { headers: readOnly })).status).toBe(200);
    expect(
      (await api(`/passes/${pass.id}/void`, { method: 'POST', headers: readOnly })).status,
    ).toBe(403);
  });
});

describe('create and read', () => {
  it('creates a pass that matches the published contract', async () => {
    const res = await create(fake.admin());
    expect(res.status).toBe(201);
    const body = PassDetailSchema.parse(await res.json());
    expect(body).toMatchObject({
      title: 'Api Member',
      status: 'active',
      version: 1,
      holderState: 'unassigned',
    });
    expect(body.publicUrl).toMatch(/\/p\/.+/);
    expect(body.downloadUrl.endsWith('/pass.pkpass')).toBe(true);
    expect(body.versions).toHaveLength(1);
    expect(body.passJson).toMatchObject({ organizationName: 'Test Gym' });
    expect(JSON.stringify(body)).not.toContain('authenticationToken');
    const got = await api(`/passes/${body.id}`, { headers: fake.admin() });
    expect(got.headers.get('etag')).toBe('"1"');
    PassDetailSchema.parse(await got.json());
  });

  it('replays an Idempotency-Key and rejects reuse with another body', async () => {
    const key = { 'idempotency-key': `k-${kit.fx.ids.token(6)}` };
    const a = await create(fake.admin(), {}, key);
    const b = await create(fake.admin(), {}, key);
    expect(b.status).toBe(201);
    expect(((await b.json()) as { id: string }).id).toBe(((await a.json()) as { id: string }).id);
    const other = await create(fake.admin(), { input: { memberName: 'Different' } }, key);
    expect(other.status).toBe(409);
    expect(((await other.json()) as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await create(fake.admin(), {}, { 'idempotency-key': 'x'.repeat(201) })).status).toBe(
      400,
    );
  });

  it('validates the body and reports problem+json', async () => {
    const res = await create(fake.admin(), { input: {} });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toBe('application/problem+json');
    expect(((await res.json()) as { code: string }).code).toBe('PASS_INPUT_INVALID');
    expect((await create(fake.admin(), { templateId: 'missing' })).status).toBe(404);
    expect((await create(fake.admin(), { holderEmail: 'nope' })).status).toBe(422);
  });

  it('lists with filters and cursor pagination', async () => {
    for (let i = 0; i < 3; i++) await create(fake.admin(), { input: { memberName: `Pager ${i}` } });
    const page1 = PassListSchema.parse(
      await (
        await api(`/passes?orgId=${kit.org.id}&q=Pager&limit=2`, { headers: fake.admin() })
      ).json(),
    );
    expect(page1.items).toHaveLength(2);
    const page2 = PassListSchema.parse(
      await (
        await api(`/passes?orgId=${kit.org.id}&q=Pager&limit=2&cursor=${page1.nextCursor}`, {
          headers: fake.admin(),
        })
      ).json(),
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const byTemplate = PassListSchema.parse(
      await (
        await api(`/passes?templateId=${kit.template.id}&status=voided&limit=5`, {
          headers: fake.admin(),
        })
      ).json(),
    );
    expect(byTemplate.items.every((p) => p.status === 'voided')).toBe(true);
  });
});

describe('update', () => {
  it('requires the current version in If-Match', async () => {
    const created = (await (await create(fake.admin())).json()) as { id: string };
    const headers = fake.admin();
    const stale = await api(
      `/passes/${created.id}`,
      json({ ...headers, 'if-match': '"7"' }, { input: { memberName: 'X' } }, 'PATCH'),
    );
    expect(stale.status).toBe(412);
    expect(((await stale.json()) as { code: string }).code).toBe('VERSION_CONFLICT');
    const ok = await api(
      `/passes/${created.id}`,
      json({ ...headers, 'if-match': '"1"' }, { input: { memberName: 'Fresh' } }, 'PATCH'),
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get('etag')).toBe('"2"');
    expect(PassDetailSchema.parse(await ok.json()).fieldSources).toEqual({ memberName: 'manual' });
    const bad = await api(
      `/passes/${created.id}`,
      json({ ...headers, 'if-match': 'abc' }, {}, 'PATCH'),
    );
    expect(bad.status).toBe(400);
  });

  it('serves version history, a retained version for rendering and a diff', async () => {
    const created = (await (
      await create(fake.admin(), { input: { memberName: 'Before' } })
    ).json()) as { id: string };
    await api(
      `/passes/${created.id}`,
      json(fake.admin(), { input: { memberName: 'After' } }, 'PATCH'),
    );
    const v1 = PassDetailSchema.parse(
      await (await api(`/passes/${created.id}/versions/1`, { headers: fake.admin() })).json(),
    );
    expect(v1.personalization).toEqual({ memberName: 'Before' });
    const diff = (await (
      await api(`/passes/${created.id}/diff?from=1&to=2`, { headers: fake.admin() })
    ).json()) as {
      changes: { path: string; from: unknown; to: unknown }[];
    };
    expect(diff.changes).toEqual([{ path: 'memberName', from: 'Before', to: 'After' }]);
    expect((await api(`/passes/${created.id}/versions/9`, { headers: fake.admin() })).status).toBe(
      404,
    );
  });

  it('voids, unvoids, rotates and deletes', async () => {
    const created = (await (await create(fake.admin())).json()) as {
      id: string;
      publicUrl: string;
    };
    const voided = await api(`/passes/${created.id}/void`, {
      method: 'POST',
      headers: fake.admin(),
    });
    expect(((await voided.json()) as { status: string }).status).toBe('voided');
    const back = await api(`/passes/${created.id}/unvoid`, {
      method: 'POST',
      headers: fake.admin(),
    });
    expect(((await back.json()) as { status: string }).status).toBe('active');
    const rotated = (await (
      await api(`/passes/${created.id}/rotate-link`, { method: 'POST', headers: fake.admin() })
    ).json()) as { publicUrl: string };
    expect(rotated.publicUrl).not.toBe(created.publicUrl);
    expect((await app.request(created.publicUrl, {}, kit.env)).status).toBe(404);
    const del = await api(`/passes/${created.id}`, { method: 'DELETE', headers: fake.admin() });
    expect(del.status).toBe(200);
    expect((await api(`/passes/${created.id}`, { headers: fake.admin() })).status).toBe(404);
  });
});

describe('per-pass images', () => {
  const put = (id: string, name: string, body: BodyInit, headers: Headers = fake.admin()) =>
    api(`/passes/${id}/assets/${name}`, {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'image/png' },
      body,
    });

  it('uploads, lists, republishes and removes an override', async () => {
    const created = (await (await create(fake.admin())).json()) as { id: string };
    const res = await put(created.id, 'icon.png', ICON_PNG);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      name: 'icon.png',
      width: 38,
      height: 38,
      size: ICON_PNG.length,
    });
    const row = await getPass(kit.env.DB, created.id);
    expect(row?.version).toBe(2);
    const list = (await (
      await api(`/passes/${created.id}/assets`, { headers: fake.admin() })
    ).json()) as { items: { name: string }[] };
    expect(list.items.map((i) => i.name)).toEqual(['icon.png']);
    expect(
      (
        await api(`/passes/${created.id}/assets/icon.png`, {
          method: 'DELETE',
          headers: fake.admin(),
        })
      ).status,
    ).toBe(200);
    expect((await getPass(kit.env.DB, created.id))?.version).toBe(3);
    expect(
      (
        await api(`/passes/${created.id}/assets/icon.png`, {
          method: 'DELETE',
          headers: fake.admin(),
        })
      ).status,
    ).toBe(404);
  });

  it('rejects files that are not valid pass images', async () => {
    const created = (await (await create(fake.admin())).json()) as { id: string };
    expect((await put(created.id, 'icon.png', new Uint8Array([1, 2, 3]))).status).toBe(422);
    expect((await put(created.id, 'nothing.png', ICON_PNG)).status).toBe(422);
    expect((await put(created.id, 'icon.gif', ICON_PNG)).status).toBe(422);
    const big = new Uint8Array(1_000_001);
    big.set(ICON_PNG);
    expect((await put(created.id, 'icon.png', big)).status).toBe(413);
    const wide = new Uint8Array(ICON_PNG);
    new DataView(wide.buffer).setUint32(16, 500);
    expect((await put(created.id, 'icon.png', wide)).status).toBe(422);
    expect((await getPass(kit.env.DB, created.id))?.version).toBe(1);
    expect(
      await first(kit.env.DB, 'SELECT 1 FROM pass_assets WHERE pass_id = ?', [created.id]),
    ).toBeNull();
  });
});

describe('refresh, email and bulk reissue', () => {
  it('queues one refresh and coalesces repeats inside the window', async () => {
    const created = (await (await create(fake.admin())).json()) as { id: string };
    kit.queue.sent.length = 0;
    const first1 = await api(`/passes/${created.id}/refresh`, {
      method: 'POST',
      headers: fake.admin(),
    });
    const second = await api(`/passes/${created.id}/refresh`, {
      method: 'POST',
      headers: fake.admin(),
    });
    expect(first1.status).toBe(202);
    expect(second.status).toBe(202);
    expect(((await first1.json()) as { accepted: boolean }).accepted).toBe(true);
    expect(
      kit.queue.sent.filter((m) => (m as { kind: string }).kind === 'pass.refresh'),
    ).toHaveLength(1);
  });

  it('queues an email to the holder or a given address, and needs a recipient', async () => {
    const created = (await (
      await create(fake.admin(), { holderEmail: 'who@example.com' })
    ).json()) as { id: string };
    const ok = await api(`/passes/${created.id}/resend-email`, json(fake.admin(), {}));
    expect(ok.status).toBe(202);
    const rows = await all<{ payload: string }>(
      kit.env.DB,
      "SELECT payload FROM outbox WHERE pass_id = ? AND kind = 'email'",
      [created.id],
    );
    expect(JSON.parse(rows[0]?.payload ?? '{}')).toEqual({ to: 'who@example.com', attach: false });
    const bare = (await (await create(fake.admin())).json()) as { id: string };
    const none = await api(`/passes/${bare.id}/resend-email`, json(fake.admin(), {}));
    expect(none.status).toBe(422);
    const other = await api(
      `/passes/${bare.id}/resend-email`,
      json(fake.admin(), { to: 'x@example.com', attach: true }),
    );
    expect(other.status).toBe(202);
  });

  it('starts a bulk reissue for admins only and records the run', async () => {
    const denied = await api(
      '/passes/bulk-reissue',
      json(fake.apiKey(), { templateId: kit.template.id }),
    );
    expect(denied.status).toBe(401);
    const res = await api(
      '/passes/bulk-reissue',
      json(fake.admin(), { templateId: kit.template.id }),
    );
    expect(res.status).toBe(202);
    const { workflowInstanceId } = (await res.json()) as { workflowInstanceId: string };
    expect(kit.workflow.created.at(-1)).toMatchObject({
      id: workflowInstanceId,
      params: {
        templateId: kit.template.id,
        version: kit.template.version,
        cause: 'template_upgrade',
      },
    });
    const run = await first<{ status: string; kind: string }>(
      kit.env.DB,
      'SELECT status, kind FROM workflow_runs WHERE instance_id = ?',
      [workflowInstanceId],
    );
    expect(run).toEqual({ status: 'queued', kind: 'bulk_reissue' });
    expect(
      (await api('/passes/bulk-reissue', json(fake.admin(), { templateId: 'nope' }))).status,
    ).toBe(404);
  });
});

describe('tenant isolation', () => {
  let foreign: Pass;
  let keyA: Headers;
  beforeAll(async () => {
    foreign = await kit.pass({ orgId: orgB.id, holderEmail: 'foreign@example.com' });
    keyA = fake.apiKey({
      orgId: kit.org.id,
      scopes: ['passes:read', 'passes:write', 'holders:write'],
    });
  });

  const probes: [string, string, unknown?][] = [
    ['GET', '/passes/{id}'],
    ['PATCH', '/passes/{id}', { input: { memberName: 'Hacked' } }],
    ['DELETE', '/passes/{id}'],
    ['POST', '/passes/{id}/void'],
    ['POST', '/passes/{id}/unvoid'],
    ['POST', '/passes/{id}/refresh'],
    ['POST', '/passes/{id}/rotate-link'],
    ['POST', '/passes/{id}/resend-email', { to: 'a@example.com' }],
    ['GET', '/passes/{id}/versions/1'],
    ['GET', '/passes/{id}/diff?from=1&to=1'],
    ['GET', '/passes/{id}/assets'],
    ['DELETE', '/passes/{id}/assets/icon.png'],
  ];

  it.each(probes)(
    '%s %s is invisible to another organization’s key',
    async (method, path, body) => {
      const init = body === undefined ? { method, headers: keyA } : json(keyA, body, method);
      const res = await api(path.replace('{id}', foreign.id), init);
      expect(res.status).toBe(404);
    },
  );

  it('blocks image upload, creation and filtering across organizations', async () => {
    const upload = await api(`/passes/${foreign.id}/assets/icon.png`, {
      method: 'PUT',
      headers: { ...keyA, 'content-type': 'image/png' },
      body: ICON_PNG,
    });
    expect(upload.status).toBe(404);
    expect((await create(keyA, { orgId: orgB.id })).status).toBe(403);
    expect((await api(`/passes?orgId=${orgB.id}`, { headers: keyA })).status).toBe(403);
    const list = PassListSchema.parse(
      await (await api('/passes?limit=200', { headers: keyA })).json(),
    );
    expect(list.items.every((p) => p.orgId === kit.org.id)).toBe(true);
    expect(list.items.some((p) => p.id === foreign.id)).toBe(false);
  });

  it('holder routes are scoped the same way', async () => {
    for (const [path, body] of [
      ['/holders/assign', { passId: foreign.id, email: 'x@example.com' }],
      ['/holders/reassign', { passId: foreign.id, email: 'x@example.com' }],
      ['/holders/unassign', { passId: foreign.id }],
      ['/holders/clear-block', { passId: foreign.id, userId: 'u' }],
    ] as const)
      expect((await api(path, json(keyA, body))).status, path).toBe(404);
    expect((await api(`/holders?orgId=${orgB.id}`, { headers: keyA })).status).toBe(403);
    const mine = (await (await api('/holders?limit=200', { headers: keyA })).json()) as {
      items: { passId: string }[];
    };
    expect(mine.items.some((h) => h.passId === foreign.id)).toBe(false);
  });

  it('delivery and bulk reissue are admin only', async () => {
    expect((await api(`/delivery?passId=${foreign.id}`, { headers: keyA })).status).toBe(401);
    expect(
      (await api('/passes/bulk-reissue', json(keyA, { templateId: kit.template.id }))).status,
    ).toBe(401);
    expect((await api(`/delivery?passId=${foreign.id}`, { headers: fake.admin() })).status).toBe(
      200,
    );
  });

  it('left the foreign pass untouched and lets a platform key through', async () => {
    const row = await getPass(kit.env.DB, foreign.id);
    expect(row).toMatchObject({
      version: 1,
      status: 'active',
      downloadToken: foreign.downloadToken,
      displayTitle: 'Alex Morgan',
    });
    const platform = fake.apiKey({ orgId: null });
    expect((await api(`/passes/${foreign.id}`, { headers: platform })).status).toBe(200);
  });
});

describe('holders API', () => {
  it('assigns, reassigns and unassigns through HTTP', async () => {
    const created = (await (await create(fake.admin())).json()) as { id: string };
    const admin = fake.admin();
    const assigned = await api(
      '/holders/assign',
      json(admin, { passId: created.id, email: 'Me@Example.com' }),
    );
    expect(await assigned.json()).toMatchObject({
      passId: created.id,
      state: 'waiting',
      email: 'me@example.com',
    });
    const re = await api('/holders/reassign', json(admin, { passId: created.id, email: null }));
    expect(await re.json()).toMatchObject({ state: 'unassigned', email: null });
    const bulk = await api(
      '/holders/assign-bulk',
      json(admin, { items: [{ passId: created.id, email: 'bulk@example.com' }] }),
    );
    expect(((await bulk.json()) as { items: unknown[] }).items).toHaveLength(1);
    expect(
      (await api('/holders/assign', json(admin, { passId: created.id, email: 'bad' }))).status,
    ).toBe(422);
    const un = await api('/holders/unassign', json(admin, { passId: created.id }));
    expect(await un.json()).toMatchObject({ state: 'unassigned' });
  });
});
