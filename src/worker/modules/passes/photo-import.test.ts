import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { run } from '../../platform/db.ts';
import { encoded } from './member-photo-test-fixtures.ts';
import { type Kit, setupKit } from './pass-test-fixtures.ts';
import { setupTenantTestAuth, type TenantTestAuth } from './tenant-test-fixtures.ts';

let kit: Kit;
let app: ReturnType<typeof createApp>;
let auth: TenantTestAuth;
const ORIGIN = 'https://wallet.test';

beforeAll(async () => {
  kit = await setupKit();
  auth = await setupTenantTestAuth(kit);
  app = createApp({ stores: auth.stores, clock: kit.clock });
});

const post = (path: string, headers: Record<string, string>, body: unknown, method = 'POST') =>
  app.request(
    `${ORIGIN}/api/v1/passes${path}`,
    {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    kit.env,
  );
const tag = (id: string, externalId: string) =>
  run(kit.env.DB, 'UPDATE passes SET external_id = ? WHERE id = ?', [externalId, id]);

describe('photo import', () => {
  it('matches file names by External ID, then serial, inside the key org', async () => {
    const a = await kit.pass();
    const b = await kit.pass();
    const dup1 = await kit.pass();
    const dup2 = await kit.pass();
    await tag(a.id, 'M-100');

    await tag(dup1.id, 'M-200');
    await tag(dup2.id, 'M-200');
    const other = await makeOrg(kit.fx);
    const foreign = await kit.pass({ orgId: other.id });
    await tag(foreign.id, 'M-300');
    const key = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    const res = await post('/photos/match', key, {
      keys: ['M-100', b.serial, 'M-200', 'M-300', 'nobody'],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      matches: [
        { key: 'M-100', passId: a.id, state: 'matched' },
        { key: b.serial, passId: b.id, state: 'matched' },
        { key: 'M-200', passId: null, state: 'ambiguous' },
        { key: 'M-300', passId: null, state: 'none' },
        { key: 'nobody', passId: null, state: 'none' },
      ],
    });
  });

  it('needs the passes:write scope and the key org', async () => {
    const readOnly = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:read'] });
    expect((await post('/photos/match', readOnly, { keys: ['x'] })).status).toBe(403);
    const other = await makeOrg(kit.fx);
    const key = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    expect((await post('/photos/match', key, { orgId: other.id, keys: ['x'] })).status).toBe(403);
  });

  it('uploads a matched photo with the same key', async () => {
    const pass = await kit.pass();
    await tag(pass.id, 'M-900');
    const key = await auth.apiKey({ orgId: kit.org.id, scopes: ['passes:write'] });
    const matched = (await (await post('/photos/match', key, { keys: ['M-900'] })).json()) as {
      matches: { passId: string }[];
    };
    const id = matched.matches[0]?.passId;
    expect(id).toBe(pass.id);
    const res = await post(
      `/${id}/member-photo`,
      key,
      { png: encoded, includeInPass: false },
      'PUT',
    );
    expect(res.status).toBe(200);
  });
});
