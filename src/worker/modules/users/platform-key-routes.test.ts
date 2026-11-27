// Platform-keys PK-6b-1: the users, status and metrics routes a Platform key may call, and what it is refused.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  fixtures,
  makeApiKey,
  makeOrg,
  makeSession,
  makeUser,
} from '../../../../test/helpers/index.ts';
import { MINTABLE_PLATFORM_SCOPES } from '../../../shared/contracts/api-keys.ts';
import { all, first, run } from '../../platform/db.ts';
import { hashSessionCookie } from '../auth/sessions.ts';
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
  const s = await makeSession(f(), { userId: user.id, roles: ['admin', 'user'] });
  return s.headers;
}

interface Case {
  name: string;
  method: string;
  scope: string;
  ok: number;
  path: () => Promise<string> | string;
  body?: unknown;
}
const user = async () => (await makeUser(f())).id;

const CASES: Case[] = [
  {
    name: 'list users',
    method: 'GET',
    scope: 'platform:users',
    ok: 200,
    path: () => '/api/v1/users',
  },
  {
    name: 'get a user',
    method: 'GET',
    scope: 'platform:users',
    ok: 200,
    path: async () => `/api/v1/users/${await user()}`,
  },
  {
    name: "list a user's passes",
    method: 'GET',
    scope: 'platform:users',
    ok: 200,
    path: async () => `/api/v1/users/${await user()}/passes`,
  },
  {
    name: 'disable a user',
    method: 'PATCH',
    scope: 'platform:users',
    ok: 200,
    path: async () => `/api/v1/users/${await user()}`,
    body: { status: 'disabled' },
  },
  {
    name: 'revoke all sessions',
    method: 'POST',
    scope: 'platform:users',
    ok: 200,
    path: async () => `/api/v1/users/${await user()}/sessions/revoke`,
  },
  {
    name: 'revoke one session',
    method: 'DELETE',
    scope: 'platform:users',
    ok: 200,
    path: async () => {
      const u = await makeUser(f());
      const s = await makeSession(f(), { userId: u.id, roles: ['user'] });
      return `/api/v1/users/${u.id}/sessions/${await hashSessionCookie(s.cookieValue)}`;
    },
  },
  {
    name: 'component health',
    method: 'GET',
    scope: 'platform:status',
    ok: 200,
    path: () => '/api/v1/status',
  },
  {
    name: 'workflow runs',
    method: 'GET',
    scope: 'platform:status',
    ok: 200,
    path: () => '/api/v1/status/workflows',
  },
  {
    name: 'list incidents',
    method: 'GET',
    scope: 'platform:status',
    ok: 200,
    path: () => '/api/v1/status/incidents',
  },
  {
    name: 'open an incident',
    method: 'POST',
    scope: 'platform:status',
    ok: 201,
    path: () => '/api/v1/status/incidents',
    body: { title: 'Slow passes', note: 'Looking into it.', component: null, impact: 'notice' },
  },
  {
    name: 'resolve an incident',
    method: 'POST',
    scope: 'platform:status',
    ok: 200,
    path: async () => {
      const opened = await send('POST', '/api/v1/status/incidents', await person(), {
        title: 'Old one',
        note: 'Done.',
        component: null,
        impact: 'notice',
      });
      return `/api/v1/status/incidents/${((await opened.json()) as { id: string }).id}/resolve`;
    },
  },
  {
    name: 'platform metrics',
    method: 'GET',
    scope: 'platform:status',
    ok: 200,
    path: () => '/api/v1/metrics/platform/overview',
  },
  {
    name: 'developer funnel',
    method: 'GET',
    scope: 'platform:status',
    ok: 200,
    path: () => '/api/v1/metrics/platform/developer',
  },
];

describe.each(CASES)('$method $name', (c) => {
  it('works for a key with the scope', async () => {
    const key = await platformKey([c.scope]);
    const res = await send(c.method, await c.path(), key.headers, c.body);
    expect(res.status).toBe(c.ok);
  });

  it('refuses a key without the scope', async () => {
    const other = c.scope === 'platform:users' ? 'platform:status' : 'platform:users';
    const key = await platformKey([other]);
    await expectProblem(
      await send(c.method, await c.path(), key.headers, c.body),
      403,
      'MISSING_SCOPE',
    );
  });

  it('refuses an org key', async () => {
    const org = await makeOrg(f());
    const key = await makeApiKey(f(), { orgId: org.id, scopes: ['org:read', 'passes:read'] });
    const res = await send(c.method, await c.path(), key.headers, c.body);
    expect([401, 403]).toContain(res.status);
  });

  it('still works for a person', async () => {
    const res = await send(c.method, await c.path(), await person(), c.body);
    expect(res.status).toBe(c.ok);
  });
});

it('reads with platform:read alone', async () => {
  const key = await platformKey(['platform:read']);
  for (const path of ['/api/v1/users', '/api/v1/status', '/api/v1/metrics/platform/developer'])
    expect((await send('GET', path, key.headers)).status).toBe(200);
  await expectProblem(
    await send('PATCH', `/api/v1/users/${await user()}`, key.headers, { status: 'disabled' }),
    403,
    'MISSING_SCOPE',
  );
});

it('mints platform:users, platform:status and platform:orgs', () => {
  for (const scope of ['platform:users', 'platform:status', 'platform:orgs'])
    expect(MINTABLE_PLATFORM_SCOPES).toContain(scope);
});

describe('PATCH /users/:id by a key', () => {
  it('is audited as the key and disables the user', async () => {
    const key = await platformKey(['platform:users']);
    const target = await user();
    expect(
      (await send('PATCH', `/api/v1/users/${target}`, key.headers, { status: 'disabled' })).status,
    ).toBe(200);
    expect(
      await all(
        h.env.DB,
        "SELECT actor_type, actor_id FROM audit_log WHERE action = 'user.disable' AND target_id = ?",
        [target],
      ),
    ).toEqual([{ actor_type: 'api_key', actor_id: key.id }]);
    expect(
      (await first<{ status: string }>(h.env.DB, 'SELECT status FROM users WHERE id = ?', [target]))
        ?.status,
    ).toBe('disabled');
  });

  it('refuses a platform admin target with 409 IDP_PLATFORM_ADMIN, and a person may', async () => {
    const key = await platformKey(['platform:users']);
    const target = await user();
    await run(h.env.DB, `UPDATE users SET last_roles = '["admin"]' WHERE id = ?`, [target]);
    await expectProblem(
      await send('PATCH', `/api/v1/users/${target}`, key.headers, { status: 'disabled' }),
      409,
      'IDP_PLATFORM_ADMIN',
    );
    expect(
      (await first<{ status: string }>(h.env.DB, 'SELECT status FROM users WHERE id = ?', [target]))
        ?.status,
    ).toBe('active');
    expect(
      (await send('PATCH', `/api/v1/users/${target}`, await person(), { status: 'disabled' }))
        .status,
    ).toBe(200);
  });

  it('refuses to disable the owner of a personal org: that is a person', async () => {
    const key = await platformKey(['platform:users']);
    const owner = await user();
    await makeOrg(f(), { personalUserId: owner });
    await expectProblem(
      await send('PATCH', `/api/v1/users/${owner}`, key.headers, { status: 'disabled' }),
      403,
      'PERSON_REQUIRED',
    );
    expect(
      (await first<{ status: string }>(h.env.DB, 'SELECT status FROM users WHERE id = ?', [owner]))
        ?.status,
    ).toBe('active');
  });
});

describe('session revokes by a key', () => {
  it('refuse a platform admin target with 409 and leave its sessions, and a person may', async () => {
    const key = await platformKey(['platform:users']);
    const target = await user();
    await run(h.env.DB, `UPDATE users SET last_roles = '["admin"]' WHERE id = ?`, [target]);
    const s = await makeSession(f(), { userId: target, roles: ['admin', 'user'] });
    const sid = await hashSessionCookie(s.cookieValue);
    for (const [method, path] of [
      ['POST', `/api/v1/users/${target}/sessions/revoke`],
      ['DELETE', `/api/v1/users/${target}/sessions/${sid}`],
    ] as const)
      await expectProblem(await send(method, path, key.headers), 409, 'IDP_PLATFORM_ADMIN');
    expect(
      (
        await first<{ revoked_at: number | null }>(
          h.env.DB,
          'SELECT revoked_at FROM sessions WHERE id_hash = ?',
          [sid],
        )
      )?.revoked_at,
    ).toBeNull();
    expect(
      (await send('DELETE', `/api/v1/users/${target}/sessions/${sid}`, await person())).status,
    ).toBe(200);
  });

  it('still work on a user who is not an admin', async () => {
    const key = await platformKey(['platform:users']);
    expect(
      (await send('POST', `/api/v1/users/${await user()}/sessions/revoke`, key.headers)).status,
    ).toBe(200);
  });
});

describe('what stays a person', () => {
  it('refuses a key every email route', async () => {
    const key = await platformKey([...MINTABLE_PLATFORM_SCOPES]);
    const id = await user();
    for (const [method, path, body] of [
      ['POST', `/api/v1/users/${id}/emails`, { email: 'a@example.test' }],
      ['DELETE', `/api/v1/users/${id}/emails/a@example.test`, undefined],
      ['POST', `/api/v1/users/${id}/emails/a@example.test/primary`, undefined],
    ] as const)
      await expectProblem(await send(method, path, key.headers, body), 403, 'PERSON_REQUIRED');
  });

  it("answers 404 to a key that names another user's session", async () => {
    const key = await platformKey(['platform:users']);
    const owner = await user();
    const s = await makeSession(f(), { userId: await user(), roles: ['user'] });
    await expectProblem(
      await send(
        'DELETE',
        `/api/v1/users/${owner}/sessions/${await hashSessionCookie(s.cookieValue)}`,
        key.headers,
      ),
      404,
      'SESSION_NOT_FOUND',
    );
  });
});

describe('metrics of a personal org', () => {
  it('are refused to a key, and the filter by org works for a regular org', async () => {
    const key = await platformKey(['platform:status']);
    const personal = await makeOrg(f(), { personalUserId: await user() });
    await expectProblem(
      await send('GET', `/api/v1/metrics/platform/overview?orgId=${personal.id}`, key.headers),
      403,
      'ORG_PERSONAL',
    );
    const regular = await makeOrg(f());
    expect(
      (await send('GET', `/api/v1/metrics/platform/overview?orgId=${regular.id}`, key.headers))
        .status,
    ).toBe(200);
  });
});
