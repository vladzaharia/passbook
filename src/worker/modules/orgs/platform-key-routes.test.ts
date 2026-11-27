// Platform-keys PK-6b-1: the orgs routes a Platform key may call (platform:orgs), and what it is refused.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  fixtures,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { all, first } from '../../platform/db.ts';
import { harness, type TestHarness } from '../auth/test-support.ts';

let h: TestHarness;
const f = () => fixtures(h.env, h.clock);
beforeEach(async () => {
  h = await harness();
});
afterEach(() => h.restore());

async function platformKey(scopes: string[]) {
  const key = await makeApiKey(f(), {
    orgId: null,
    kind: 'platform',
    scopes,
    expiresAt: h.clock.now() + 30 * 86_400_000,
    ipAllow: ['198.51.100.0/24'],
  });
  return { id: key.id, headers: { ...key.headers, 'cf-connecting-ip': '198.51.100.7' } };
}
const send = (method: string, path: string, headers: Record<string, string>, json?: unknown) =>
  h.call(path, { method, headers, json });
async function person() {
  const user = await makeUser(f());
  return (await makeSession(f(), { userId: user.id, roles: ['admin', 'user'] })).headers;
}
const slug = () => `o${f().ids.id().replaceAll('-', '').slice(-14)}`;
const orgId = async () => (await makeOrg(f())).id;
const personalOrg = async () =>
  (await makeOrg(f(), { personalUserId: (await makeUser(f())).id })).id;
const readEntitlements = async (id: string) =>
  (await (
    await send('GET', `/api/v1/platform/orgs/${id}/entitlements`, await person())
  ).json()) as {
    revision: number;
  };

interface Case {
  name: string;
  method: string;
  ok: number;
  path: () => Promise<string> | string;
  body?: () => Promise<unknown> | unknown;
}
const P = '/api/v1/platform';
const CASES: Case[] = [
  { name: 'list orgs', method: 'GET', ok: 200, path: () => '/api/v1/orgs' },
  { name: 'get an org', method: 'GET', ok: 200, path: async () => `/api/v1/orgs/${await orgId()}` },
  {
    name: 'create an org',
    method: 'POST',
    ok: 201,
    path: () => '/api/v1/orgs',
    body: () => ({ slug: slug(), name: 'Crew', addMe: false }),
  },
  {
    name: 'suspend an org',
    method: 'POST',
    ok: 200,
    path: async () => `/api/v1/orgs/${await orgId()}/status`,
    body: () => ({ status: 'suspended' }),
  },
  { name: 'closed orgs', method: 'GET', ok: 200, path: () => `${P}/closed-orgs` },
  { name: 'personal labels', method: 'GET', ok: 200, path: () => `${P}/personal-org-labels` },
  { name: 'read presets', method: 'GET', ok: 200, path: () => `${P}/entitlement-presets` },
  {
    name: 'change a preset',
    method: 'PUT',
    ok: 200,
    path: () => `${P}/entitlement-presets`,
    body: async () => {
      const { presets } = (await (
        await send('GET', `${P}/entitlement-presets`, await person())
      ).json()) as {
        presets: { preset: string; revision: number; values: Record<string, number> }[];
      };
      const trial = presets.find((p) => p.preset === 'trial');
      return {
        preset: 'trial',
        expectedRevision: trial?.revision,
        values: { members: (trial?.values.members ?? 1) + 1 },
      };
    },
  },
  {
    name: "read an org's features",
    method: 'GET',
    ok: 200,
    path: async () => `${P}/orgs/${await orgId()}/entitlements`,
  },
  {
    name: "set an org's features",
    method: 'PUT',
    ok: 200,
    path: async () => `${P}/orgs/${await orgId()}/entitlements`,
    body: undefined,
  },
  {
    name: 'list holds',
    method: 'GET',
    ok: 200,
    path: async () => `${P}/orgs/${await orgId()}/retention/holds`,
  },
  {
    name: 'place a hold',
    method: 'POST',
    ok: 201,
    path: async () => `${P}/orgs/${await orgId()}/retention/holds`,
    body: () => ({ reason: 'inquiry' }),
  },
  {
    name: 'org receipts',
    method: 'GET',
    ok: 200,
    path: async () => `${P}/orgs/${await orgId()}/retention/receipts`,
  },
  {
    name: 'an org receipt, which is not there',
    method: 'GET',
    ok: 404,
    path: async () => `${P}/orgs/${await orgId()}/retention/receipts/none/download`,
  },
  { name: 'platform receipts', method: 'GET', ok: 200, path: () => `${P}/retention/receipts` },
  {
    name: 'a platform receipt, which is not there',
    method: 'GET',
    ok: 404,
    path: () => `${P}/retention/receipts/none/download`,
  },
];

/** The PUT of an org's features needs the revision it reads: the org is made once per call. */
async function resolve(c: Case) {
  const path = await c.path();
  if (c.name === "set an org's features") {
    const id = path.split('/')[5] as string;
    return {
      path,
      body: {
        expectedRevision: (await readEntitlements(id)).revision,
        preset: 'trial',
        overrides: {},
      },
    };
  }
  return { path, body: await c.body?.() };
}

describe.each(CASES)('$method $name', (c) => {
  it('works for a key with platform:orgs', async () => {
    const key = await platformKey(['platform:orgs']);
    const { path, body } = await resolve(c);
    expect((await send(c.method, path, key.headers, body)).status).toBe(c.ok);
  });

  it('refuses a key without the scope', async () => {
    const key = await platformKey(['platform:users', 'platform:status']);
    const { path, body } = await resolve(c);
    await expectProblem(await send(c.method, path, key.headers, body), 403, 'MISSING_SCOPE');
  });

  it('refuses an org key', async () => {
    const org = await makeOrg(f());
    const key = await makeApiKey(f(), { orgId: org.id, scopes: ['org:read', 'org:manage'] });
    const { path, body } = await resolve(c);
    expect([401, 403]).toContain((await send(c.method, path, key.headers, body)).status);
  });

  it('still works for a person', async () => {
    const { path, body } = await resolve(c);
    expect((await send(c.method, path, await person(), body)).status).toBe(c.ok);
  });
});

it('reads with platform:read alone, and writes need platform:orgs', async () => {
  const key = await platformKey(['platform:read']);
  for (const path of ['/api/v1/orgs', `${P}/closed-orgs`, `${P}/entitlement-presets`])
    expect((await send('GET', path, key.headers)).status).toBe(200);
  await expectProblem(
    await send('POST', '/api/v1/orgs', key.headers, { slug: slug(), name: 'Crew', addMe: false }),
    403,
    'MISSING_SCOPE',
  );
});

describe('POST /orgs by a key', () => {
  it('refuses addMe true with 422 ORG_ADD_ME_NEEDS_PERSON and makes nothing', async () => {
    const key = await platformKey(['platform:orgs']);
    const name = slug();
    await expectProblem(
      await send('POST', '/api/v1/orgs', key.headers, { slug: name, name: 'Crew', addMe: true }),
      422,
      'ORG_ADD_ME_NEEDS_PERSON',
    );
    expect(await first(h.env.DB, 'SELECT 1 AS x FROM orgs WHERE slug = ?', [name])).toBeNull();
  });

  it('makes the org with no member when addMe is left out, audited as the key', async () => {
    const key = await platformKey(['platform:orgs']);
    const res = await send('POST', '/api/v1/orgs', key.headers, { slug: slug(), name: 'Crew' });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(await all(h.env.DB, 'SELECT 1 FROM org_memberships WHERE org_id = ?', [id])).toEqual([]);
    expect(
      await all(
        h.env.DB,
        "SELECT actor_type, actor_id FROM audit_log WHERE action = 'org.create' AND target_id = ?",
        [id],
      ),
    ).toEqual([{ actor_type: 'api_key', actor_id: key.id }]);
  });

  it('still adds a person who is signed in', async () => {
    const res = await send('POST', '/api/v1/orgs', await person(), { slug: slug(), name: 'Crew' });
    const { id } = (await res.clone().json()) as { id: string };
    expect(res.status, await res.clone().text()).toBe(201);
    expect(
      await all(h.env.DB, 'SELECT 1 FROM org_memberships WHERE org_id = ?', [id]),
    ).toHaveLength(1);
  });
});

describe("a personal org is not a key's to touch", () => {
  it('refuses a status move with 403 PERSON_REQUIRED, and a person may', async () => {
    const key = await platformKey(['platform:orgs']);
    const id = await personalOrg();
    for (const status of ['suspended', 'active'])
      await expectProblem(
        await send('POST', `/api/v1/orgs/${id}/status`, key.headers, { status }),
        403,
        'PERSON_REQUIRED',
      );
    expect(
      (await send('POST', `/api/v1/orgs/${id}/status`, await person(), { status: 'suspended' }))
        .status,
    ).toBe(200);
  });

  it('refuses reads and writes of its directory page, features, holds and receipts', async () => {
    const key = await platformKey(['platform:orgs']);
    const id = await personalOrg();
    for (const [method, path, body] of [
      ['GET', `/api/v1/orgs/${id}`],
      ['GET', `${P}/orgs/${id}/entitlements`],
      [
        'PUT',
        `${P}/orgs/${id}/entitlements`,
        { expectedRevision: 1, preset: 'trial', overrides: {} },
      ],
      ['GET', `${P}/orgs/${id}/retention/holds`],
      ['POST', `${P}/orgs/${id}/retention/holds`, { reason: 'inquiry' }],
      ['GET', `${P}/orgs/${id}/retention/receipts`],
    ] as const)
      await expectProblem(await send(method, path, key.headers, body), 403, 'ORG_PERSONAL');
  });
});

describe('writes by a key', () => {
  it('audits a status move as the key', async () => {
    const key = await platformKey(['platform:orgs']);
    const id = await orgId();
    await send('POST', `/api/v1/orgs/${id}/status`, key.headers, { status: 'suspended' });
    expect(
      await all(
        h.env.DB,
        "SELECT actor_type, actor_id FROM audit_log WHERE action = 'org.suspend' AND target_id = ?",
        [id],
      ),
    ).toEqual([{ actor_type: 'api_key', actor_id: key.id }]);
  });

  it("names the key's creator in updated_by and the key in the audit row", async () => {
    const key = await platformKey(['platform:orgs']);
    const id = await orgId();
    const read = await readEntitlements(id);
    expect(
      (
        await send('PUT', `${P}/orgs/${id}/entitlements`, key.headers, {
          expectedRevision: read.revision,
          preset: 'trial',
          overrides: {},
        })
      ).status,
    ).toBe(200);
    const creator = await first<{ created_by: string }>(
      h.env.DB,
      'SELECT created_by FROM api_keys WHERE id = ?',
      [key.id],
    );
    expect(
      (
        await first<{ updated_by: string }>(
          h.env.DB,
          'SELECT updated_by FROM org_entitlements WHERE org_id = ?',
          [id],
        )
      )?.updated_by,
    ).toBe(creator?.created_by);
    expect(
      await all(
        h.env.DB,
        "SELECT actor_type, actor_id FROM audit_log WHERE action = 'org.entitlements_update' AND org_id = ?",
        [id],
      ),
    ).toEqual([{ actor_type: 'api_key', actor_id: key.id }]);
  });

  it('places a hold audited as the key, placed by its creator', async () => {
    const key = await platformKey(['platform:orgs']);
    const id = await orgId();
    expect(
      (await send('POST', `${P}/orgs/${id}/retention/holds`, key.headers, { reason: 'inquiry' }))
        .status,
    ).toBe(201);
    const creator = await first<{ created_by: string }>(
      h.env.DB,
      'SELECT created_by FROM api_keys WHERE id = ?',
      [key.id],
    );
    expect(
      await all(
        h.env.DB,
        'SELECT placed_by_kind, placed_by FROM retention_holds WHERE org_id = ?',
        [id],
      ),
    ).toEqual([{ placed_by_kind: 'platform', placed_by: creator?.created_by }]);
    expect(
      await all(
        h.env.DB,
        "SELECT actor_type, actor_id FROM audit_log WHERE action = 'retention.hold.place' AND org_id = ?",
        [id],
      ),
    ).toEqual([{ actor_type: 'api_key', actor_id: key.id }]);
  });
});

describe('what stays a person', () => {
  it('refuses a key closing an org and releasing a hold, whatever scopes it holds', async () => {
    const key = await platformKey(['platform:orgs', 'platform:users', 'platform:status']);
    const id = await orgId();
    await expectProblem(
      await send('DELETE', `/api/v1/orgs/${id}`, key.headers),
      403,
      'PERSON_REQUIRED',
    );
    await expectProblem(
      await send('POST', `${P}/orgs/${id}/retention/holds/none/release`, key.headers),
      403,
      'PERSON_REQUIRED',
    );
  });
});
