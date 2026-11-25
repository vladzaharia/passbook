import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { createFakeIdp, type FakeIdp, installFakeIdp } from '../../../../test/helpers/fake-idp.ts';
import { makeApiKey, makeOrg, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { setLimit } from '../../../../test/helpers/limits.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import * as kit from '../api-keys/test-kit.ts';
import { create, f, member, org } from '../api-keys/test-kit.ts';
import type { TestHarness } from '../auth/test-support.ts';
import { ensurePersonalOrg } from '../orgs/personal.ts';
import { invitationByHash } from './repo.ts';

const DAY = 86_400_000;
let h: TestHarness;
let idp: FakeIdp;
let failMail = false;

beforeEach(async () => {
  failMail = false;
  idp = createFakeIdp();
  await kit.setup();
  h = kit.h;
  // The harness env carries no IDP binding; the provisioner is a fake behind it.
  installFakeIdp(h.env, idp);
  const send = h.env.EMAIL.send.bind(h.env.EMAIL);
  (h.env as unknown as { EMAIL: unknown }).EMAIL = {
    send: async (m: Parameters<typeof send>[0]) => {
      if (failMail) throw new Error('mail down');
      return send(m);
    },
  };
});
afterEach(kit.teardown);

const url = (orgId: string, tail = '') => `/api/v1/orgs/${orgId}/developer-invitations${tail}`;
const invite = (headers: Record<string, string>, json: object, orgId = org.id) =>
  h.call(url(orgId), { method: 'POST', headers, json });
const liveKey = (scopes: string[], orgId = org.id) =>
  makeApiKey(f(), { orgId, scopes, expiresAt: h.clock.now() + 30 * DAY });
/** The org's rows only: the test database is shared by the whole file. */
const rows = (table: string) =>
  all<Record<string, unknown>>(h.env.DB, `SELECT * FROM ${table} WHERE org_id = ? ORDER BY id`, [
    org.id,
  ]);

describe('POST /orgs/{id}/developer-invitations', () => {
  it('lets an org_admin invite with no roles: one row, one mail, audit, no org invitation', async () => {
    const { session, user } = await member('org_admin');
    const res = await invite(session.headers, { email: 'Dev@Agency.test' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      email: string;
      roles: string[];
      state: string;
    };
    expect(body).toMatchObject({ email: 'dev@agency.test', roles: [], state: 'pending' });
    expect(await rows('org_invitations')).toHaveLength(1); // the org_admin member's own
    const [row] = await rows('developer_invitations');
    expect(row).toMatchObject({ org_invitation_id: null, created_by_user: user.id });
    expect(h.mail).toHaveLength(1);
    const mail = h.mail[0];
    expect(mail?.subject).toMatch(/^Developer invitation from /);
    expect(mail?.text).toMatch(/\/invite#d_[\w-]{43}/);
    expect(mail?.text).not.toContain('id.test');
    const audit = await first<{ actor_type: string; detail: string }>(
      h.env.DB,
      "SELECT actor_type, detail FROM audit_log WHERE action = 'developer_invitation.create' AND org_id = ?",
      [org.id],
    );
    expect(audit?.actor_type).toBe('user');
    expect(JSON.parse(audit?.detail ?? '{}')).toEqual({ roles: [], via: 'console' });
    expect(audit?.detail).not.toContain('agency');
  });

  it('with roles, pairs an org invitation that counts against members', async () => {
    const { session } = await member('org_admin');
    const res = await invite(session.headers, { email: 'dev@agency.test', roles: ['read_only'] });
    expect(res.status).toBe(201);
    const [dev] = await rows('developer_invitations');
    const paired = await first<{ roles: string; email: string }>(
      h.env.DB,
      'SELECT roles, email FROM org_invitations WHERE id = ?',
      [dev?.org_invitation_id as string],
    );
    expect(paired).toEqual({ roles: '["read_only"]', email: 'dev@agency.test' });
    const token = /invite#(d_[\w-]{43})/.exec(h.mail[0]?.text ?? '')?.[1] ?? '';
    expect(h.mail[0]?.text).toContain('You also join as a read-only member');
    expect((await invitationByHash(h.env.DB, await sha256Hex(token)))?.id).toBe(dev?.id);
  });

  it('refuses an integration_admin and a stale sign-in', async () => {
    const other = await member('integration_admin');
    await expectProblem(
      await invite(other.session.headers, { email: 'd@a.test' }),
      403,
      'FORBIDDEN',
    );
    const { user } = await member('org_admin');
    const stale = await makeSession(f(), {
      userId: user.id,
      roles: ['user'],
      authTime: h.clock.now() - 3_600_000,
    });
    await expectProblem(
      await invite(stale.headers, { email: 'd@a.test' }),
      403,
      'STEP_UP_REQUIRED',
    );
    expect(await rows('developer_invitations')).toHaveLength(0);
  });

  it('answers a duplicate pending address with 409 and counts rate limits', async () => {
    const { session } = await member('org_admin');
    expect((await invite(session.headers, { email: 'd@a.test' })).status).toBe(201);
    await expectProblem(
      await invite(session.headers, { email: 'D@a.test' }),
      409,
      'DEVELOPER_INVITE_PENDING',
    );
    for (let i = 0; i < 4; i++)
      expect((await invite(session.headers, { email: `d${i}@a.test` })).status).toBe(201);
    await expectProblem(
      await invite(session.headers, { email: 'late@a.test' }),
      429,
      'RATE_LIMITED',
    );
  });

  it('refuses personal and sandbox orgs', async () => {
    const { session } = await member('org_admin', { platformAdmin: true });
    const sandbox = await makeOrg(f(), { kind: 'developer' });
    await expectProblem(
      await invite(session.headers, { email: 'd@a.test' }, sandbox.id),
      409,
      'SANDBOX_PREVIEW_ONLY',
    );
    const admin = await member('org_admin', { platformAdmin: true });
    await ensurePersonalOrg(createServiceContext(h.env, { clock: h.clock }), {
      userId: admin.user.id,
      sessionId: await sha256Hex(admin.session.cookieValue),
    });
    const personal = await first<{ id: string }>(
      h.env.DB,
      'SELECT id FROM orgs WHERE personal_user_id = ?',
      [admin.user.id],
    );
    await expectProblem(
      await invite(admin.session.headers, { email: 'd@a.test' }, personal?.id ?? ''),
      409,
      'ORG_PERSONAL_SINGLE_MEMBER',
    );
  });

  it('is refused while Polaris ID is unreachable or misconfigured', async () => {
    const { session } = await member('org_admin');
    idp.failNext('IDP_UPSTREAM', 'health');
    await expectProblem(
      await invite(session.headers, { email: 'd@a.test' }),
      503,
      'IDP_UNAVAILABLE',
    );
    const wrong = createFakeIdp({ groupName: 'someone_else' });
    installFakeIdp(h.env, wrong);
    await expectProblem(
      await invite(session.headers, { email: 'd@a.test' }),
      503,
      'IDP_UNAVAILABLE',
    );
    expect(await rows('developer_invitations')).toHaveLength(0);
  });

  it('revokes both rows when the mail fails', async () => {
    const { session } = await member('org_admin');
    failMail = true;
    const res = await invite(session.headers, { email: 'd@a.test', roles: ['read_only'] });
    expect(res.status).toBe(503);
    const [dev] = await rows('developer_invitations');
    expect(dev?.revoked_at).not.toBeNull();
    const paired = await first<{ revoked_at: number | null }>(
      h.env.DB,
      'SELECT revoked_at FROM org_invitations WHERE id = ?',
      [dev?.org_invitation_id as string],
    );
    expect(paired?.revoked_at).not.toBeNull();
    const actions = (await rows('audit_log')).map((r) => r.action);
    expect(actions).toContain('developer_invitation.revoke');
  });
});

describe('members.developers', () => {
  /** A key is never asked for a step-up, so the clock can move past the hourly cap between invitations. */
  const inviteMany = async (key: { headers: Record<string, string> }, n: number) => {
    for (let i = 0; i < n; i++) {
      expect((await invite(key.headers, { email: `d${i}@a.test` })).status).toBe(201);
      h.clock.advance(3_600_000);
    }
  };
  it.each([1, 2, 5])('stops at %i pending invitations', async (limit) => {
    const key = await liveKey(['members:write']);
    await setLimit(h.env.DB, org.id, 'members.developers', limit);
    await inviteMany(key, limit);
    await expectProblem(
      await invite(key.headers, { email: 'over@a.test' }),
      403,
      'FEATURE_LIMIT_REACHED',
    );
  });

  it('has no cap for unlimited and refuses at 0', async () => {
    const key = await liveKey(['members:write']);
    await setLimit(h.env.DB, org.id, 'members.developers', null);
    await inviteMany(key, 4);
    await setLimit(h.env.DB, org.id, 'members.developers', 0);
    await expectProblem(
      await invite(key.headers, { email: 'zero@a.test' }),
      403,
      'FEATURE_LIMIT_REACHED',
    );
  });

  it('counts live sponsorships with pending invitations', async () => {
    const { session, user } = await member('org_admin');
    await setLimit(h.env.DB, org.id, 'members.developers', 1);
    const res = await invite(session.headers, { email: 'first@a.test' });
    const { id } = (await res.json()) as { id: string };
    await run(
      h.env.DB,
      `INSERT INTO developer_sponsors (id, org_id, user_id, invitation_id, idp_subject, group_source, created_at)
       VALUES ('s1', ?, ?, ?, 'sub', 'added', 1)`,
      [org.id, user.id, id],
    );
    await run(h.env.DB, 'UPDATE developer_invitations SET revoked_at = 1 WHERE id = ?', [id]);
    await expectProblem(
      await invite(session.headers, { email: 'second@a.test' }),
      403,
      'FEATURE_LIMIT_REACHED',
    );
  });
});

describe('a key', () => {
  it('naming members:write on a Live key invites, audited as the key', async () => {
    const key = await liveKey(['members:write']);
    const res = await invite(key.headers, { email: 'k@a.test' });
    expect(res.status).toBe(201);
    const [dev] = await rows('developer_invitations');
    expect(dev).toMatchObject({ created_by_user: null, created_by_key: key.id });
    const audit = await first<{ actor_type: string; actor_id: string }>(
      h.env.DB,
      "SELECT actor_type, actor_id FROM audit_log WHERE action = 'developer_invitation.create' AND org_id = ?",
      [org.id],
    );
    expect(audit).toEqual({ actor_type: 'api_key', actor_id: key.id });
  });

  it('is refused without the scope, in another org, and in test mode', async () => {
    const read = await liveKey(['members:read']);
    await expectProblem(await invite(read.headers, { email: 'k@a.test' }), 403, 'MISSING_SCOPE');
    const elsewhere = await liveKey(['members:write'], kit.other.id);
    expect((await invite(elsewhere.headers, { email: 'k@a.test' })).status).toBeGreaterThanOrEqual(
      403,
    );
    expect(await rows('developer_invitations')).toHaveLength(0);
  });

  it('is refused at mint in test mode, and a role key never holds members:write', async () => {
    const { session } = await member('org_admin');
    const body = {
      orgId: org.id,
      name: 'Invites',
      scopes: ['members:write'],
      expiresAt: h.clock.now() + 30 * DAY,
    };
    await expectProblem(
      await create({ ...session.headers, 'x-passbook-mode': 'test' }, { ...body, mode: 'test' }),
      422,
      'API_KEY_CREDENTIAL_LIVE_ORG',
    );
    expect((await create(session.headers, body)).status).toBe(201);
    const role = await create(session.headers, {
      orgId: org.id,
      name: 'Role',
      scopes: [],
      roles: ['org_admin'],
    });
    const made = (await role.json()) as { scopes: string[]; secret: string };
    expect(made.scopes).toContain('members:read');
    expect(made.scopes).not.toContain('members:write');
    await expectProblem(
      await invite({ authorization: `Bearer ${made.secret}` }, { email: 'k@a.test' }),
      403,
      'MISSING_SCOPE',
    );
  });
});

describe('administering roles and races', () => {
  it('refuses a key pairing an administering role, and takes a plain one', async () => {
    const key = await liveKey(['members:write']);
    for (const role of ['org_admin', 'integration_admin'])
      await expectProblem(
        await invite(key.headers, { email: `${role}@a.test`, roles: [role] }),
        403,
        'DEVELOPER_INVITE_ROLE_NEEDS_SESSION',
      );
    expect(await rows('developer_invitations')).toHaveLength(0);
    expect(await rows('org_invitations')).toHaveLength(0);
    expect((await invite(key.headers, { email: 'ok@a.test', roles: ['read_only'] })).status).toBe(
      201,
    );
  });

  it('refuses a key removing a developer whose membership administers', async () => {
    const { session } = await member('org_admin');
    const key = await liveKey(['members:write']);
    const dev = await makeUser(f());
    const made = (await (
      await invite(session.headers, { email: 'adm@a.test', roles: ['org_admin'] })
    ).json()) as { id: string };
    const [row] = await rows('developer_invitations');
    await run(
      h.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES ('m-adm', ?, ?, ?, '["org_admin"]', 1)`,
      [org.id, dev.id, row?.org_invitation_id as string],
    );
    await run(
      h.env.DB,
      `INSERT INTO developer_sponsors (id, org_id, user_id, invitation_id, idp_subject, group_source, created_at)
       VALUES ('s-adm', ?, ?, ?, 'sub-adm', 'added', 1)`,
      [org.id, dev.id, made.id],
    );
    await expectProblem(
      await h.call(`/api/v1/orgs/${org.id}/developers/${dev.id}`, {
        method: 'DELETE',
        headers: key.headers,
      }),
      403,
      'DEVELOPER_INVITE_ROLE_NEEDS_SESSION',
    );
    const live = await first<{ ended_at: number | null }>(
      h.env.DB,
      "SELECT ended_at FROM developer_sponsors WHERE id = 's-adm'",
    );
    expect(live?.ended_at).toBeNull();
  });

  it('lets only one of two racing invitations for an address through', async () => {
    const key = await liveKey(['members:write']);
    const results = await Promise.all([
      invite(key.headers, { email: 'race@a.test' }),
      invite(key.headers, { email: 'race@a.test' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await rows('developer_invitations')).toHaveLength(1);
  });
});

describe('listing, revoking and removing', () => {
  it('lists pending invitations, then shows a revoked one', async () => {
    const { session } = await member('org_admin');
    const made = (await (await invite(session.headers, { email: 'd@a.test' })).json()) as {
      id: string;
    };
    const list = async () =>
      (await (await h.call(url(org.id), { headers: session.headers })).json()) as {
        items: { id: string; state: string }[];
      };
    expect((await list()).items).toMatchObject([{ id: made.id, state: 'pending' }]);
    const del = await h.call(url(org.id, `/${made.id}`), {
      method: 'DELETE',
      headers: session.headers,
    });
    expect(del.status).toBe(200);
    expect((await list()).items).toMatchObject([{ id: made.id, state: 'revoked' }]);
    await expectProblem(
      await h.call(url(org.id, `/${made.id}`), { method: 'DELETE', headers: session.headers }),
      409,
      'DEVELOPER_INVITE_CONFLICT',
    );
  });

  it('removes a developer: sponsorship ended, paired membership revoked, always ok', async () => {
    const { session } = await member('org_admin');
    const dev = await makeUser(f());
    const made = (await (
      await invite(session.headers, { email: 'd@a.test', roles: ['read_only'] })
    ).json()) as { id: string };
    const [row] = await rows('developer_invitations');
    await run(
      h.env.DB,
      `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
       VALUES ('m-dev', ?, ?, ?, '["read_only"]', 1)`,
      [org.id, dev.id, row?.org_invitation_id as string],
    );
    await run(
      h.env.DB,
      `INSERT INTO developer_sponsors (id, org_id, user_id, invitation_id, idp_subject, group_source, created_at)
       VALUES ('s2', ?, ?, ?, 'sub-2', 'added', 1)`,
      [org.id, dev.id, made.id],
    );
    const list = (await (
      await h.call(`/api/v1/orgs/${org.id}/developers`, { headers: session.headers })
    ).json()) as { available: boolean; items: { userId: string; roles: string[] | null }[] };
    expect(list.available).toBe(true);
    expect(list.items).toMatchObject([{ userId: dev.id, roles: ['read_only'] }]);
    const del = () =>
      h.call(`/api/v1/orgs/${org.id}/developers/${dev.id}`, {
        method: 'DELETE',
        headers: session.headers,
      });
    expect((await del()).status).toBe(200);
    expect((await del()).status).toBe(200);
    const sponsor = await first<{ end_reason: string }>(
      h.env.DB,
      "SELECT end_reason FROM developer_sponsors WHERE id = 's2'",
    );
    expect(sponsor?.end_reason).toBe('removed');
    const membership = await first<{ revoked_at: number | null }>(
      h.env.DB,
      "SELECT revoked_at FROM org_memberships WHERE id = 'm-dev'",
    );
    expect(membership?.revoked_at).not.toBeNull();
    const actions = (await rows('audit_log')).map((r) => r.action);
    expect(actions).toContain('developer.remove');
  });

  it('reports the section unavailable at 0 developers', async () => {
    const { session } = await member('org_admin');
    await setLimit(h.env.DB, org.id, 'members.developers', 0);
    const list = (await (
      await h.call(`/api/v1/orgs/${org.id}/developers`, { headers: session.headers })
    ).json()) as { available: boolean; limit: number | null };
    expect(list).toMatchObject({ available: false, limit: 0 });
  });
});
