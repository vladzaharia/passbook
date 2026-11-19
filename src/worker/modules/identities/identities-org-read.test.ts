import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import {
  type Fixtures,
  fixtures,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createSessionStore } from '../auth/sessions.ts';

let appEnv: AppEnv;
let fx: Fixtures;
let app: ReturnType<typeof createApp>;
let admin: SessionFixture;
let member: SessionFixture;
let orgA: string;
let orgB: string;

const list = (query: string, headers?: Record<string, string>) =>
  app.request(`/api/v1/identities${query}`, { headers }, appEnv);

async function addMember(orgId: string, userId: string) {
  const invitationId = fx.ids.id();
  const now = fx.clock.now();
  await run(
    appEnv.DB,
    `INSERT INTO org_invitations (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, '["org_admin"]', fx.ids.token(), now, now + 3600_000, now, userId],
  );
  await run(
    appEnv.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, '["org_admin"]', ?)`,
    [fx.ids.id(), orgId, userId, invitationId, now],
  );
}

const insertIdentity = (id: string, orgId: string | null) =>
  run(
    env.DB,
    `INSERT INTO signing_identities
       (id, org_id, label, pass_type_identifier, team_identifier, source, env_prefix, is_default, created_at)
     VALUES (?, ?, ?, ?, 'TEAM123456', 'env', ?, 0, 1)`,
    [id, orgId, `Label ${id}`, `pass.test.${id}`, id.toUpperCase()],
  );

beforeAll(async () => {
  appEnv = await makeEnv();
});
beforeEach(async () => {
  fx = fixtures(appEnv);
  const a = await makeUser(fx);
  admin = await makeSession(fx, { userId: a.id, roles: ['admin', 'user'] });
  const m = await makeUser(fx);
  member = await makeSession(fx, { userId: m.id });
  orgA = (await makeOrg(fx)).id;
  orgB = (await makeOrg(fx)).id;
  await addMember(orgA, m.id);
  await run(env.DB, "DELETE FROM signing_identities WHERE id LIKE 'scope-%'");
  await insertIdentity('scope-platform', null);
  await insertIdentity('scope-a', orgA);
  await insertIdentity('scope-b', orgB);
  app = createApp({
    stores: { ...denyAllStores, sessions: createSessionStore(appEnv, fx.clock) },
    clock: fx.clock,
  });
});

const ids = async (res: Response) =>
  ((await res.json()) as { items: { id: string }[] }).items.map((i) => i.id).sort();

describe('identities org read authority', () => {
  it('lets a member read only their organization identities', async () => {
    const res = await list(`?orgId=${orgA}`, member.headers);
    expect(res.status).toBe(200);
    expect(await ids(res)).toEqual(['scope-a']);
  });

  it('refuses another organization, a non-member and an unauthenticated read', async () => {
    await expectProblem(await list(`?orgId=${orgB}`, member.headers), 403, 'FORBIDDEN');
    const stranger = await makeUser(fx);
    const other = await makeSession(fx, { userId: stranger.id });
    await expectProblem(await list(`?orgId=${orgA}`, other.headers), 403, 'FORBIDDEN');
    expect((await list(`?orgId=${orgA}`)).status).toBe(401);
  });

  it('keeps the unscoped list and every write platform-admin only', async () => {
    await expectProblem(await list('', member.headers), 403, 'FORBIDDEN');
    const detail = await app.request(
      '/api/v1/identities/scope-a',
      { headers: member.headers },
      appEnv,
    );
    expect(detail.status).toBe(403);
    const del = await app.request(
      '/api/v1/identities/scope-a',
      { method: 'DELETE', headers: member.headers },
      appEnv,
    );
    expect(del.status).toBe(403);
  });

  it('lets a platform admin read any organization or the whole list', async () => {
    expect(await ids(await list(`?orgId=${orgB}`, admin.headers))).toEqual(['scope-b']);
    expect(await ids(await list('', admin.headers))).toEqual(
      expect.arrayContaining(['scope-platform', 'scope-a', 'scope-b']),
    );
  });
});
