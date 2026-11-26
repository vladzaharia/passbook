import { beforeAll, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { makeApiKey, makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { tagFixture } from '../nfc/tags-test-fixtures.ts';

let f: Awaited<ReturnType<typeof tagFixture>>;
let app: ReturnType<typeof createApp>;
let sandboxId: string;
beforeAll(async () => {
  f = await tagFixture();
  app = createApp({
    stores: { ...denyAllStores, apiKeys: createApiKeyStore(f.kit.env, f.kit.clock) },
    clock: f.kit.clock,
  });
  sandboxId = (await makeOrg(f.kit.fx, { kind: 'developer' })).id;
});

type Mode = 'live' | 'test';
const orgId = () => f.kit.org.id;
const keyOf = async (scopes: string[], mode: Mode, org = orgId()) =>
  (await makeApiKey(f.kit.fx, { orgId: org, scopes, mode })).headers;
const send = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
  app.request(
    `https://wallet.test/api/v1${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    f.kit.env,
  );
const refused = (res: Response) => expectProblem(res, 403, 'MODE_LIVE_REQUIRED');
/** A Test key never holds the credential scope: the guard drops it before any handler. */
const unscoped = (res: Response) =>
  expectProblem(res, 403, ['MISSING_SCOPE', 'MODE_LIVE_REQUIRED']);

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

describe('brand kit', () => {
  it('refuses a Test key on every write', async () => {
    const t = await keyOf(['brand:manage'], 'test');
    await refused(await send('PATCH', '/brand', t, { accent: '#112233' }));
    await refused(await send('PUT', '/brand/web-logo', t, { png: PNG }));
    await refused(await send('DELETE', '/brand/web-logo', t));
    await refused(
      await send('POST', `/orgs/${orgId()}/brand-assets`, t, { slot: 'webLogo', png: PNG }),
    );
  });

  it('refuses a Test key on a pass-setup save, brand fields included', async () => {
    const t = await keyOf(['brand:manage', 'org:write'], 'test');
    await refused(
      await send('PATCH', `/orgs/${orgId()}/pass-setup`, t, {
        expectedRevision: 'x',
        brand: { accent: '#112233' },
      }),
    );
  });

  it('keeps the writes for a Live key and in a sandbox', async () => {
    const live = await keyOf(['brand:manage'], 'live');
    expect((await send('PATCH', '/brand', live, { accent: '#112233' })).status).toBe(200);
    const sandbox = await keyOf(['brand:manage'], 'test', sandboxId);
    expect((await send('PATCH', '/brand', sandbox, { accent: '#223344' })).status).toBe(200);
  });
});

describe('members', () => {
  it('refuses a Test key that holds members:write', async () => {
    const t = await keyOf(['members:write'], 'test');
    await unscoped(
      await send('POST', `/orgs/${orgId()}/developer-invitations`, t, { email: 'dev@example.com' }),
    );
    await unscoped(await send('DELETE', `/orgs/${orgId()}/developers/${f.kit.fx.ids.id()}`, t));
  });
});

describe('tag types', () => {
  it('refuses a Test key to create, edit and archive; a Live key and a sandbox keep them', async () => {
    const live = await keyOf(['scanning:write'], 'live');
    const made = await send('POST', `/nfc/tag-types?orgId=${orgId()}`, live, {
      name: 'Band',
      use: 'member',
    });
    expect(made.status).toBe(201);
    const id = ((await made.json()) as { id: string }).id;
    const t = await keyOf(['scanning:write'], 'test');
    await refused(
      await send('POST', `/nfc/tag-types?orgId=${orgId()}`, t, { name: 'Band two', use: 'member' }),
    );
    await refused(await send('PATCH', `/nfc/tag-types/${id}`, t, { version: 1, name: 'Renamed' }));
    await refused(await send('POST', `/nfc/tag-types/${id}/archive`, t, { version: 1 }));
    const sandbox = await keyOf(['scanning:write'], 'test', sandboxId);
    expect(
      (
        await send('POST', `/nfc/tag-types?orgId=${sandboxId}`, sandbox, {
          name: 'Band',
          use: 'member',
        })
      ).status,
    ).toBe(201);
  });
});

describe('saved import mappings', () => {
  const body = {
    templateId: '',
    name: 'Gym export',
    columns: ['Num', 'Who'],
    plan: {
      mapping: { memberName: { from: '/Who' } },
      holderEmail: null,
      externalId: { from: '/Num' },
      match: 'externalId',
      keepManual: false,
      save: true,
    },
  };

  it('refuses a Test key to save or delete, and a Live key may', async () => {
    const input = { ...body, templateId: f.kit.template.id };
    const t = await keyOf(['passes:write'], 'test');
    await refused(await send('PUT', '/pass-imports/mappings', t, input));
    await refused(
      await send(
        'DELETE',
        `/pass-imports/mappings?templateId=${input.templateId}&name=Gym%20export`,
        t,
      ),
    );
    const live = await keyOf(['passes:write'], 'live');
    expect((await send('PUT', '/pass-imports/mappings', live, input)).status).toBe(200);
  });
});

describe('zones', () => {
  it('refuses a Test key to edit, archive and restore a zone', async () => {
    const id = f.kit.fx.ids.id();
    await run(
      f.kit.env.DB,
      "INSERT INTO scan_zones (id, org_id, key, name, created_at, updated_at) VALUES (?, ?, 'z', 'Zone', 1, 1)",
      [id, orgId()],
    );
    const t = await keyOf(['scanning:write'], 'test');
    await refused(await send('PATCH', `/scan-zones/${id}`, t, { name: 'Renamed' }));
    await refused(await send('POST', `/scan-zones/${id}/archive`, t));
    await refused(await send('POST', `/scan-zones/${id}/restore`, t));
    expect(
      (
        await first<{ name: string }>(f.kit.env.DB, 'SELECT name FROM scan_zones WHERE id = ?', [
          id,
        ])
      )?.name,
    ).toBe('Zone');
  });
});
