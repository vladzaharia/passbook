import { env } from 'cloudflare:workers';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  allowInvalidRoleNames,
  editSessionAuthority,
  type Fixtures,
  fakeRateLimiter,
  fixtures,
  makeApiKey,
  makeEnv,
  makeOrg,
  makeSession,
  makeUser,
  type SessionFixture,
} from '../../../../test/helpers/index.ts';
import { MODE_HEADER } from '../../../shared/contracts/common.ts';
import type { OrgRole } from '../../../shared/contracts/org-membership.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { ManualClock } from '../../platform/clock.ts';
import type { AppBindings } from '../../platform/context.ts';
import { all, first, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore, hashSessionCookie } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { writeScope } from './repo.ts';
import {
  clearSettingsCache,
  decodePlatformSettings,
  getOrgSettings,
  getPlatformSettings,
  updateSettings,
} from './service.ts';

describe('batched platform settings decoder', () => {
  const result = (rows: { key: string; value: string }[]): D1Result =>
    ({ results: rows }) as D1Result;

  it('uses validated stored values and schema defaults for invalid or missing keys', () => {
    const settings = decodePlatformSettings(
      result([
        { key: 'scan.undoWindowMinutes', value: '25' },
        { key: 'scan.lookupsPerHour', value: '1' },
        { key: 'unknown', value: 'not JSON' },
      ]),
    );
    expect(settings['scan.undoWindowMinutes']).toBe(25);
    expect(settings['scan.lookupsPerHour']).toBe(200);
    expect(settings['auth.magicLinkEnabled']).toBe(true);
  });

  it('preserves JSON parse errors for known keys', () => {
    expect(() =>
      decodePlatformSettings(result([{ key: 'scan.undoWindowMinutes', value: 'not JSON' }])),
    ).toThrow();
  });
});

let appEnv: AppEnv;
let fx: Fixtures;
let platformAdmin: SessionFixture;
let tenantUser: SessionFixture;
let app: OpenAPIHono<AppBindings>;
const call = async (
  method: string,
  path: string,
  body?: unknown,
  headers = platformAdmin.headers,
  requestEnv = appEnv,
): Promise<Response> =>
  app.request(
    `/api/v1/settings${path}`,
    {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    requestEnv,
  );

async function addMembership(
  orgId: string,
  userId = tenantUser.userId,
  roles: OrgRole[] = ['org_admin'],
): Promise<string> {
  const invitationId = fx.ids.id();
  const membershipId = fx.ids.id();
  const now = fx.clock.now();
  await run(
    appEnv.DB,
    `INSERT INTO org_invitations
      (id, org_id, email, roles, token_hash, created_at, expires_at, accepted_at)
     SELECT ?, ?, primary_email, ?, ?, ?, ?, ? FROM users WHERE id = ?`,
    [invitationId, orgId, JSON.stringify(roles), fx.ids.token(), now, now + 3600_000, now, userId],
  );
  await run(
    appEnv.DB,
    `INSERT INTO org_memberships (id, org_id, user_id, invitation_id, roles, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [membershipId, orgId, userId, invitationId, JSON.stringify(roles), now],
  );
  return membershipId;
}

async function orgEffects(orgId: string) {
  return {
    org: await first<{ updated_at: number; config_revision: number }>(
      appEnv.DB,
      'SELECT updated_at, config_revision FROM orgs WHERE id = ?',
      [orgId],
    ),
    settings: await all(
      appEnv.DB,
      'SELECT key, value, updated_by, updated_at FROM settings WHERE scope = ? ORDER BY key',
      [`org:${orgId}`],
    ),
    audit: await all(
      appEnv.DB,
      "SELECT * FROM audit_log WHERE org_id = ? AND action = 'settings.update' ORDER BY id",
      [orgId],
    ),
  };
}

/** Intervene after preflight, immediately before the real settings transaction. */
async function atSettingsCommit<T>(
  intervene: () => Promise<void>,
  request: (requestEnv: AppEnv) => Promise<T>,
): Promise<T> {
  const sqlOf = new WeakMap<D1PreparedStatement, string>();
  let commits = 0;
  const db = new Proxy(appEnv.DB, {
    get(target, prop) {
      if (prop === 'prepare') {
        return (sql: string) => {
          const statement = target.prepare(sql);
          return new Proxy(statement, {
            get(prepared, key) {
              if (key === 'bind') {
                return (...values: unknown[]) => {
                  const bound = prepared.bind(...values);
                  sqlOf.set(bound, sql);
                  return bound;
                };
              }
              const value = Reflect.get(prepared, key, prepared);
              return typeof value === 'function' ? value.bind(prepared) : value;
            },
          });
        };
      }
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const isSettingsWrite = statements.some((statement) =>
            /\b(?:(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM)\s+(?:settings|authority_grants)|UPDATE\s+orgs\s+(?:AS\s+o|SET))\b/i.test(
              sqlOf.get(statement) ?? '',
            ),
          );
          if (isSettingsWrite) {
            commits++;
            if (commits === 1) await intervene();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const result = await request({ ...appEnv, DB: db });
  expect(commits, 'the settings write batch was reached').toBe(1);
  return result;
}

type List = {
  items: { key: string; value: unknown; default?: unknown }[];
  oidc?: { issuer: string; adminGroup: string | null; userGroup: string | null };
};

beforeAll(async () => {
  appEnv = await makeEnv({ RL_API_KEY: fakeRateLimiter({ limit: 1000 }) });
});
beforeEach(async () => {
  await run(env.DB, 'DELETE FROM settings');
  await run(env.DB, 'DELETE FROM audit_log');
  clearSettingsCache(env.DB);
  fx = fixtures(appEnv);
  const admin = await makeUser(fx);
  platformAdmin = await makeSession(fx, { userId: admin.id, roles: ['admin', 'user'] });
  const member = await makeUser(fx);
  tenantUser = await makeSession(fx, { userId: member.id });
  app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(appEnv, fx.clock),
      apiKeys: createApiKeyStore(appEnv, fx.clock),
    },
    clock: fx.clock,
  });
});

describe('settings api', () => {
  it('rejects control and bidi characters in the sender name', async () => {
    for (const v of ['A\u2028B', 'A\u202EB', 'A\r\nBcc: x']) {
      expect((await call('PUT', '', { values: { 'email.senderName': v } })).status).toBe(422);
    }
    expect((await call('PUT', '', { values: { 'email.senderName': 'Acme Passes' } })).status).toBe(
      200,
    );
  });

  it('validates org support links', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    const put = (values: object) =>
      call('PUT', '', { scope: `org:${org.id}`, values }, tenantUser.headers);
    for (const values of [
      { 'support.url': 'javascript:alert(1)' },
      { 'support.url': 'http://x.example' },
      { 'support.url': 'https://user:pw@x.example' },
      { 'support.email': 'a@b' },
    ]) {
      expect((await put(values)).status).toBe(422);
    }
    expect(
      (await put({ 'support.url': 'https://x.example/help', 'support.email': 'help@x.example' }))
        .status,
    ).toBe(200);
  });

  it('lists every registered key with defaults and the read-only oidc block', async () => {
    const body = (await (await call('GET', '')).json()) as List;
    expect(body.items.map((i) => i.key)).toContain('retention.auditDays');
    expect(body.items.find((i) => i.key === 'retention.auditDays')).toMatchObject({
      value: 365,
      default: 365,
    });
    expect(body.oidc).toEqual({
      issuer: appEnv.OIDC_ISSUER,
      adminGroup: appEnv.OIDC_ADMIN_GROUP || null,
      userGroup: appEnv.OIDC_USER_GROUP || null,
    });
  });

  it('updates, audits the diff, and resets with null', async () => {
    const put = await call('PUT', '', { values: { 'retention.auditDays': 90 } });
    expect(put.status).toBe(200);
    expect(((await put.json()) as List).oidc).toEqual({
      issuer: appEnv.OIDC_ISSUER,
      adminGroup: appEnv.OIDC_ADMIN_GROUP || null,
      userGroup: appEnv.OIDC_USER_GROUP || null,
    });
    const ctx = createServiceContext(appEnv);
    expect((await getPlatformSettings(ctx))['retention.auditDays']).toBe(90);

    const rows = await all<{ action: string; detail: string }>(
      env.DB,
      "SELECT action, detail FROM audit_log WHERE action = 'settings.update'",
    );
    expect(JSON.parse(rows[0]?.detail ?? '{}')).toEqual({
      changes: { 'retention.auditDays': { from: 365, to: 90 } },
    });

    await call('PUT', '', { values: { 'retention.auditDays': null } });
    expect((await getPlatformSettings(ctx))['retention.auditDays']).toBe(365);
  });

  it('does not audit a no-op update', async () => {
    await call('PUT', '', { values: { 'retention.auditDays': 365 } });
    const rows = await all(env.DB, "SELECT 1 FROM audit_log WHERE action = 'settings.update'");
    expect(rows).toHaveLength(0);
  });

  it('rejects unknown keys and out-of-range values without writing anything', async () => {
    const res = await call('PUT', '', {
      values: { 'retention.auditDays': 5, 'nope.key': 1, 'email.senderName': 'Ok' },
    });
    expect(res.status).toBe(422);
    const problem = (await res.json()) as { code: string; issues: { path: string }[] };
    expect(problem.code).toBe('INVALID_SETTING');
    expect(problem.issues.map((i) => i.path).sort()).toEqual(['nope.key', 'retention.auditDays']);
    expect(await all(env.DB, "SELECT 1 FROM settings WHERE scope = 'platform'")).toHaveLength(0);
  });

  it('rejects invalid system and empty organization scopes', async () => {
    expect((await call('GET', '?scope=system')).status).toBe(422);
    expect((await call('GET', '?scope=org:')).status).toBe(422);
    expect((await call('PUT', '', { scope: 'org:', values: {} })).status).toBe(422);
  });

  it('keeps org settings apart from platform and other orgs', async () => {
    const a = await makeOrg(fx);
    const b = await makeOrg(fx);
    await addMembership(a.id);
    const res = await call(
      'PUT',
      '',
      {
        scope: `org:${a.id}`,
        values: { 'branding.accent': '#aabbcc' },
      },
      tenantUser.headers,
    );
    expect(res.status).toBe(200);
    expect(
      (
        await call(
          'PUT',
          '',
          { scope: `org:${a.id}`, values: { 'branding.accent': 'red' } },
          tenantUser.headers,
        )
      ).status,
    ).toBe(422);
    const ctx = createServiceContext(appEnv);
    expect((await getOrgSettings(ctx, a.id))['branding.accent']).toBe('#aabbcc');
    expect((await getOrgSettings(ctx, b.id))['branding.accent']).toBeUndefined();
    const audit = await all<{ org_id: string }>(
      env.DB,
      "SELECT org_id FROM audit_log WHERE action = 'settings.update'",
    );
    expect(audit.map((r) => r.org_id)).toEqual([a.id]);
  });

  it('resolves the pass email buddy per org: off by default, audited when turned on', async () => {
    const a = await makeOrg(fx);
    const b = await makeOrg(fx);
    await addMembership(a.id);
    const list = (await (
      await call('GET', `?scope=org:${a.id}`, undefined, tenantUser.headers)
    ).json()) as List;
    expect(list.items.find((i) => i.key === 'email.buddy')).toMatchObject({
      value: false,
      default: false,
    });
    const ctx = createServiceContext(appEnv);
    expect((await getOrgSettings(ctx, a.id))['email.buddy']).toBe(false);
    const put = (values: object) =>
      call('PUT', '', { scope: `org:${a.id}`, values }, tenantUser.headers);
    expect((await put({ 'email.buddy': 'yes' })).status).toBe(422);
    expect((await put({ 'email.buddy': true })).status).toBe(200);
    expect((await getOrgSettings(ctx, a.id))['email.buddy']).toBe(true);
    expect((await getOrgSettings(ctx, b.id))['email.buddy']).toBe(false);
    const audit = await all<{ org_id: string; detail: string }>(
      env.DB,
      "SELECT org_id, detail FROM audit_log WHERE action = 'settings.update'",
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]?.org_id).toBe(a.id);
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toEqual({
      changes: { 'email.buddy': { from: false, to: true } },
    });
  });

  it('requires a platform admin for platform settings', async () => {
    expect((await call('GET', '', undefined, tenantUser.headers)).status).toBe(403);
    expect((await call('PUT', '', { values: {} }, tenantUser.headers)).status).toBe(403);
  });
});

describe('organization settings authorization', () => {
  it('lets an org administrator without a platform role read, write, and reset its settings', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    const scope = `org:${org.id}`;

    const before = await call('GET', `?scope=${scope}`, undefined, tenantUser.headers);
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as List;
    expect(beforeBody).not.toHaveProperty('oidc');
    expect(beforeBody.items.find((item) => item.key === 'email.buddy')).toMatchObject({
      value: false,
    });

    const write = await call(
      'PUT',
      '',
      {
        scope,
        values: { 'branding.accent': '#123456', 'email.buddy': true },
      },
      tenantUser.headers,
    );
    expect(write.status).toBe(200);
    const writeBody = (await write.json()) as List;
    expect(writeBody).not.toHaveProperty('oidc');
    expect(writeBody.items.find((item) => item.key === 'branding.accent')).toMatchObject({
      value: '#123456',
      updatedBy: tenantUser.userId,
    });

    const read = await call('GET', `?scope=${scope}`, undefined, tenantUser.headers);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as List;
    expect(readBody).not.toHaveProperty('oidc');
    expect(readBody.items.find((item) => item.key === 'email.buddy')).toMatchObject({
      value: true,
    });

    const reset = await call(
      'PUT',
      '',
      {
        scope,
        values: { 'branding.accent': null, 'email.buddy': null },
      },
      tenantUser.headers,
    );
    expect(reset.status).toBe(200);
    const resetBody = (await reset.json()) as List;
    expect(resetBody).not.toHaveProperty('oidc');
    const items = resetBody.items;
    expect(items.find((item) => item.key === 'branding.accent')).toMatchObject({ value: null });
    expect(items.find((item) => item.key === 'email.buddy')).toMatchObject({ value: false });
    expect((await orgEffects(org.id)).settings).toHaveLength(0);
  });

  it('preserves CSRF and mode selection without exposing OIDC in either org mode', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    await addMembership(org.id, platformAdmin.userId);
    const scope = `org:${org.id}`;
    const testHeaders = { ...tenantUser.headers, [MODE_HEADER]: 'test' };
    const noCsrf = { ...testHeaders, 'x-csrf-token': '' };
    expect((await call('PUT', '', { scope, values: { 'email.buddy': true } }, noCsrf)).status).toBe(
      403,
    );
    const written = await call('PUT', '', { scope, values: { 'email.buddy': true } }, testHeaders);
    expect(written.status).toBe(200);
    expect(await written.json()).not.toHaveProperty('oidc');

    for (const headers of [
      { ...tenantUser.headers, [MODE_HEADER]: 'test' },
      { ...tenantUser.headers, [MODE_HEADER]: 'live' },
      platformAdmin.headers,
    ]) {
      const response = await call('GET', `?scope=${scope}`, undefined, headers);
      expect(response.status).toBe(200);
      const body = (await response.json()) as List;
      expect(body).not.toHaveProperty('oidc');
      expect(body.items.find((item) => item.key === 'email.buddy')).toMatchObject({ value: true });
    }
    const adminWrite = await call(
      'PUT',
      '',
      {
        scope,
        values: { 'email.buddy': false },
      },
      platformAdmin.headers,
    );
    expect(adminWrite.status).toBe(200);
    expect(await adminWrite.json()).not.toHaveProperty('oidc');
  });

  it.each([
    'integration_admin',
    'template_author',
    'template_reviewer',
    'template_publisher',
    'read_only',
  ] as const)('allows %s to read but not manage settings', async (role) => {
    const org = await makeOrg(fx);
    await addMembership(org.id, tenantUser.userId, [role]);
    const scope = `org:${org.id}`;
    const before = await orgEffects(org.id);
    expect((await call('GET', `?scope=${scope}`, undefined, tenantUser.headers)).status).toBe(200);
    expect(
      (
        await call(
          'PUT',
          '',
          {
            scope,
            values: { 'branding.accent': '#abcdef' },
          },
          tenantUser.headers,
        )
      ).status,
    ).toBe(403);
    expect(await orgEffects(org.id)).toEqual(before);
  });

  it.each([
    ['org_admin', 'unknown_role'],
    ['org_admin', 'org_admin'],
    ['org_admin', 1],
  ])('rejects malformed membership role sets %j', async (...roles) => {
    const org = await makeOrg(fx);
    // Inserts reject these role sets now (0029); drop that guard to keep covering the authority check.
    await allowInvalidRoleNames(appEnv.DB);
    await addMembership(org.id, tenantUser.userId, roles as unknown as OrgRole[]);
    const scope = `org:${org.id}`;
    const before = await orgEffects(org.id);
    expect((await call('GET', `?scope=${scope}`, undefined, tenantUser.headers)).status).toBe(403);
    expect(
      (
        await call(
          'PUT',
          '',
          {
            scope,
            values: { 'email.buddy': true },
          },
          tenantUser.headers,
        )
      ).status,
    ).toBe(403);
    expect(await orgEffects(org.id)).toEqual(before);
  });

  it('lets a pass operator read but not modify organization settings', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    const scope = `org:${org.id}`;
    expect(
      (
        await call(
          'PUT',
          '',
          {
            scope,
            values: { 'branding.accent': '#123456' },
          },
          tenantUser.headers,
        )
      ).status,
    ).toBe(200);

    const operator = await makeUser(fx);
    const operatorSession = await makeSession(fx, { userId: operator.id });
    await addMembership(org.id, operator.id, ['pass_operator']);
    const before = await orgEffects(org.id);
    const read = await call('GET', `?scope=${scope}`, undefined, operatorSession.headers);
    expect(read.status).toBe(200);
    expect(
      ((await read.json()) as List).items.find((item) => item.key === 'branding.accent'),
    ).toMatchObject({ value: '#123456' });
    expect(
      (
        await call(
          'PUT',
          '',
          {
            scope,
            values: { 'branding.accent': '#abcdef' },
          },
          operatorSession.headers,
        )
      ).status,
    ).toBe(403);
    expect(await orgEffects(org.id)).toEqual(before);
  });

  it('does not treat a platform admin as an implicit organization member', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    const scope = `org:${org.id}`;
    expect(
      (
        await call(
          'PUT',
          '',
          {
            scope,
            values: { 'branding.accent': '#123456' },
          },
          tenantUser.headers,
        )
      ).status,
    ).toBe(200);
    const before = await orgEffects(org.id);

    expect((await call('GET', `?scope=${scope}`)).status).toBe(403);
    expect(
      (
        await call('PUT', '', {
          scope,
          values: { 'branding.accent': '#abcdef' },
        })
      ).status,
    ).toBe(403);
    expect(await orgEffects(org.id)).toEqual(before);
  });

  it('requires a session even for a valid organization API key', async () => {
    const org = await makeOrg(fx);
    const key = await makeApiKey(fx, { orgId: org.id });
    expect(await createApiKeyStore(appEnv, fx.clock).resolve(key.secret)).toMatchObject({
      kind: 'api_key',
      orgId: org.id,
    });
    const before = await orgEffects(org.id);
    expect((await call('GET', `?scope=org:${org.id}`, undefined, key.headers)).status).toBe(401);
    expect(
      (
        await call(
          'PUT',
          '',
          {
            scope: `org:${org.id}`,
            values: { 'branding.accent': '#abcdef' },
          },
          key.headers,
        )
      ).status,
    ).toBe(401);
    expect(await orgEffects(org.id)).toEqual(before);
  });

  it('does not let an org administrator access platform settings or impact', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    expect((await call('GET', `?scope=org:${org.id}`, undefined, tenantUser.headers)).status).toBe(
      200,
    );
    const before = await all(
      appEnv.DB,
      "SELECT * FROM settings WHERE scope = 'platform' ORDER BY key",
    );
    for (const path of ['', '?scope=platform', '/impact']) {
      expect((await call('GET', path, undefined, tenantUser.headers)).status).toBe(403);
    }
    for (const body of [
      { values: { 'retention.auditDays': 90 } },
      { scope: 'platform', values: { 'retention.auditDays': 90 } },
    ]) {
      expect((await call('PUT', '', body, tenantUser.headers)).status).toBe(403);
    }
    expect(
      await all(appEnv.DB, "SELECT * FROM settings WHERE scope = 'platform' ORDER BY key"),
    ).toEqual(before);
  });

  it('masks missing and different organizations with the same denial for reads and writes', async () => {
    const own = await makeOrg(fx);
    const other = await makeOrg(fx);
    await addMembership(own.id);
    const otherUser = await makeUser(fx);
    const otherSession = await makeSession(fx, { userId: otherUser.id });
    await addMembership(other.id, otherUser.id);
    expect(
      (
        await call(
          'PUT',
          '',
          {
            scope: `org:${other.id}`,
            values: { 'branding.accent': '#123456' },
          },
          otherSession.headers,
        )
      ).status,
    ).toBe(200);
    expect((await call('GET', `?scope=org:${own.id}`, undefined, tenantUser.headers)).status).toBe(
      200,
    );
    const before = await orgEffects(other.id);
    const missingScope = `org:missing-${fx.ids.id()}`;
    const otherScope = `org:${other.id}`;

    for (const method of ['GET', 'PUT'] as const) {
      const request = (scope: string) =>
        method === 'GET'
          ? call('GET', `?scope=${scope}`, undefined, tenantUser.headers)
          : call(
              'PUT',
              '',
              { scope, values: { 'branding.accent': '#abcdef' } },
              tenantUser.headers,
            );
      const foreign = await request(otherScope);
      const missing = await request(missingScope);
      expect(foreign.status).toBe(403);
      expect(missing.status).toBe(403);
      const foreignProblem = (await foreign.json()) as { code: string; detail: string };
      const missingProblem = (await missing.json()) as { code: string; detail: string };
      expect({ code: missingProblem.code, detail: missingProblem.detail }).toEqual({
        code: foreignProblem.code,
        detail: foreignProblem.detail,
      });
    }
    expect(
      (await call('GET', `?scope=${otherScope}&orgId=${own.id}`, undefined, tenantUser.headers))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          'PUT',
          '',
          {
            scope: otherScope,
            orgId: own.id,
            values: { 'branding.accent': '#abcdef' },
          },
          tenantUser.headers,
        )
      ).status,
    ).toBe(403);
    expect(await orgEffects(other.id)).toEqual(before);
  });

  it('moves only the target config revision, and never updated_at, for every settings write', async () => {
    const org = await makeOrg(fx);
    const other = await makeOrg(fx);
    await addMembership(org.id);
    const scope = `org:${org.id}`;
    const otherBefore = await orgEffects(other.id);
    const stamp = (await orgEffects(org.id)).org?.updated_at;
    let config = (await orgEffects(org.id)).org?.config_revision ?? 0;
    for (const [values, moves] of [
      [{ 'branding.accent': '#123456' }, true],
      [{ 'branding.accent': null }, true],
      [{}, false],
    ] as const) {
      expect((await call('PUT', '', { scope, values }, tenantUser.headers)).status).toBe(200);
      const after = (await orgEffects(org.id)).org;
      expect(after?.updated_at).toBe(stamp);
      if (moves) expect(after?.config_revision).toBeGreaterThan(config);
      else expect(after?.config_revision).toBe(config);
      config = after?.config_revision ?? config;
    }
    expect((await orgEffects(org.id)).audit).toHaveLength(2);
    expect(await orgEffects(other.id)).toEqual(otherBefore);
  });

  it('moves the config revision for inserting and removing an explicit default override', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    const scope = `org:${org.id}`;
    const start = (await orgEffects(org.id)).org;
    const put = (value: boolean | null) =>
      call('PUT', '', { scope, values: { 'email.buddy': value } }, tenantUser.headers);

    expect((await put(false)).status).toBe(200);
    const inserted = await orgEffects(org.id);
    expect(inserted.org?.config_revision).toBeGreaterThan(start?.config_revision ?? 0);
    expect(inserted.org?.updated_at).toBe(start?.updated_at);
    expect(inserted.settings).toHaveLength(1);
    expect(inserted.audit).toHaveLength(0);
    expect((await put(false)).status).toBe(200);
    const repeated = await orgEffects(org.id);
    expect(repeated.settings).toEqual(inserted.settings);
    expect(repeated.audit).toHaveLength(0);

    expect((await put(null)).status).toBe(200);
    const removed = await orgEffects(org.id);
    expect(removed.org?.config_revision).toBeGreaterThan(inserted.org?.config_revision ?? 0);
    expect(removed.org?.updated_at).toBe(start?.updated_at);
    expect(removed.settings).toHaveLength(0);
    expect(removed.audit).toHaveLength(0);
  });

  it('retains trusted service writes without weakening HTTP membership checks', async () => {
    const org = await makeOrg(fx);
    const ctx = createServiceContext(appEnv, { clock: fx.clock });
    const start = (await orgEffects(org.id)).org;
    await updateSettings(
      ctx,
      { type: 'system', id: null },
      {
        scope: `org:${org.id}`,
        values: { 'email.buddy': true },
      },
    );
    const after = await orgEffects(org.id);
    expect(after.org?.updated_at).toBe(start?.updated_at);
    expect(after.org?.config_revision).toBeGreaterThan(start?.config_revision ?? 0);
    expect(after.settings).toHaveLength(1);
    expect(after.audit).toHaveLength(1);
    expect((await call('GET', `?scope=org:${org.id}`, undefined, tenantUser.headers)).status).toBe(
      403,
    );
  });

  it('requires the exact org, actor, and org:manage capability for session writes', async () => {
    const org = await makeOrg(fx);
    const other = await makeOrg(fx);
    await addMembership(org.id);
    const ctx = createServiceContext(appEnv, { clock: fx.clock });
    const session = await createSessionStore(appEnv, fx.clock).resolve(tenantUser.cookieValue);
    if (!session) throw new Error('Session fixture missing');
    const authority = await tenantAuthorityOf(ctx, session, org.id, 'org:manage');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const actor = { type: 'user' as const, id: tenantUser.userId };
    const input = { scope: `org:${org.id}`, values: { 'branding.accent': '#123456' } };
    const before = await orgEffects(org.id);
    const otherBefore = await orgEffects(other.id);

    await expect(
      updateSettings(ctx, actor, input, { ...authority, capability: 'org:read' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      updateSettings(ctx, actor, { ...input, scope: `org:${other.id}` }, authority),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      updateSettings(ctx, { type: 'user', id: platformAdmin.userId }, input, authority),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      updateSettings(ctx, { type: 'system', id: tenantUser.userId }, input, authority),
    ).rejects.toMatchObject({ status: 403 });

    expect(
      await writeScope(
        ctx,
        `org:${other.id}`,
        input.values,
        [],
        actor.id,
        otherBefore.org?.config_revision ?? null,
        authority,
      ),
    ).toBe(false);
    expect(
      await writeScope(
        ctx,
        input.scope,
        input.values,
        [],
        actor.id,
        before.org?.config_revision ?? null,
        { ...authority, capability: 'org:read' },
      ),
    ).toBe(false);
    expect(
      await writeScope(
        ctx,
        input.scope,
        input.values,
        [],
        platformAdmin.userId,
        before.org?.config_revision ?? null,
        authority,
      ),
    ).toBe(false);
    expect(await orgEffects(org.id)).toEqual(before);
    expect(await orgEffects(other.id)).toEqual(otherBefore);
  });

  it('rechecks the stored membership grant for a forged manage capability at commit', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id, tenantUser.userId, ['read_only']);
    const ctx = createServiceContext(appEnv, { clock: fx.clock });
    const session = await createSessionStore(appEnv, fx.clock).resolve(tenantUser.cookieValue);
    if (!session) throw new Error('Session fixture missing');
    const authority = await tenantAuthorityOf(ctx, session, org.id, 'org:read');
    if (authority.kind !== 'session') throw new Error('Expected session authority');
    const before = await orgEffects(org.id);
    await expect(
      updateSettings(
        ctx,
        { type: 'user', id: tenantUser.userId },
        { scope: `org:${org.id}`, values: { 'email.buddy': true } },
        { ...authority, capability: 'org:manage' },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(await orgEffects(org.id)).toEqual(before);
  });

  it('refuses a stale settings save with 409 when a concurrent write moves the config revision', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    const scope = `org:${org.id}`;
    expect(
      (
        await call(
          'PUT',
          '',
          {
            scope,
            values: { 'branding.accent': '#123456', 'support.url': 'https://example.com/help' },
          },
          tenantUser.headers,
        )
      ).status,
    ).toBe(200);
    const before = await orgEffects(org.id);
    let afterConcurrent = before;

    const denied = await atSettingsCommit(
      async () => {
        expect(
          (
            await call(
              'PUT',
              '',
              {
                scope,
                values: { 'email.buddy': true },
              },
              tenantUser.headers,
            )
          ).status,
        ).toBe(200);
        afterConcurrent = await orgEffects(org.id);
      },
      (requestEnv) =>
        call(
          'PUT',
          '',
          {
            scope,
            values: {
              'branding.accent': '#abcdef',
              'support.url': null,
              'email.buddy': false,
            },
          },
          tenantUser.headers,
          requestEnv,
        ),
    );

    expect(afterConcurrent.org?.config_revision).toBeGreaterThan(before.org?.config_revision ?? 0);
    // A stale save is a conflict to refetch, not a lost permission: 409 SETTINGS_CHANGED, nothing written.
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ code: 'SETTINGS_CHANGED' });
    expect(await orgEffects(org.id)).toEqual(afterConcurrent);
  });

  it.each(['membership', 'session'] as const)(
    'still fences an empty settings update when %s changes before commit',
    async (change) => {
      const org = await makeOrg(fx);
      const membership = await addMembership(org.id);
      const scope = `org:${org.id}`;
      const before = await orgEffects(org.id);
      const sessionId = await hashSessionCookie(tenantUser.cookieValue);
      const denied = await atSettingsCommit(
        async () => {
          if (change === 'membership') {
            await run(appEnv.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
              fx.clock.now(),
              membership,
            ]);
          } else {
            await run(appEnv.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
              fx.clock.now(),
              sessionId,
            ]);
          }
        },
        (requestEnv) => call('PUT', '', { scope, values: {} }, tenantUser.headers, requestEnv),
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'ACTOR_CHANGED' });
      const after = await orgEffects(org.id);
      expect(after.settings).toEqual(before.settings);
      expect(after.audit).toEqual(before.audit);
      expect(after.org).toEqual(before.org);
    },
  );

  it('does not fail a save when the org timestamp moves, and 409s when the config revision does', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    const scope = `org:${org.id}`;
    // updated_at is a timestamp, not an epoch: touching it mid-request changes nothing for the save.
    const touched = await atSettingsCommit(
      async () => {
        await run(appEnv.DB, 'UPDATE orgs SET updated_at = updated_at + 1 WHERE id = ?', [org.id]);
      },
      (requestEnv) =>
        call('PUT', '', { scope, values: { 'email.buddy': true } }, tenantUser.headers, requestEnv),
    );
    expect(touched.status).toBe(200);
    const before = await orgEffects(org.id);
    const stale = await atSettingsCommit(
      async () => {
        await run(appEnv.DB, "UPDATE orgs SET name = 'Renamed mid-save' WHERE id = ?", [org.id]);
      },
      (requestEnv) =>
        call(
          'PUT',
          '',
          { scope, values: { 'email.buddy': false } },
          tenantUser.headers,
          requestEnv,
        ),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'SETTINGS_CHANGED' });
    expect((await orgEffects(org.id)).settings).toEqual(before.settings);
  });

  it.each(['user disabled', 'org suspended', 'session expired', 'session idle expired'] as const)(
    'fences the complete batch when %s at commit',
    async (change) => {
      const org = await makeOrg(fx);
      await addMembership(org.id);
      const scope = `org:${org.id}`;
      expect(
        (
          await call(
            'PUT',
            '',
            {
              scope,
              values: { 'branding.accent': '#123456', 'support.url': 'https://example.com/help' },
            },
            tenantUser.headers,
          )
        ).status,
      ).toBe(200);
      const before = await orgEffects(org.id);
      const sessionId = await hashSessionCookie(tenantUser.cookieValue);
      const denied = await atSettingsCommit(
        async () => {
          if (change === 'user disabled') {
            await run(appEnv.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [
              tenantUser.userId,
            ]);
          } else if (change === 'org suspended') {
            await run(appEnv.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
          } else if (change === 'session expired') {
            await editSessionAuthority(
              appEnv.DB,
              'UPDATE sessions SET expires_at = ? WHERE id_hash = ?',
              [fx.clock.now(), sessionId],
            );
          } else {
            await run(appEnv.DB, 'UPDATE sessions SET idle_expires_at = ? WHERE id_hash = ?', [
              fx.clock.now(),
              sessionId,
            ]);
          }
        },
        (requestEnv) =>
          call(
            'PUT',
            '',
            {
              scope,
              values: {
                'branding.accent': '#abcdef',
                'support.url': null,
                'email.buddy': true,
              },
            },
            tenantUser.headers,
            requestEnv,
          ),
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        code: change === 'org suspended' ? 'ORG_ACCESS_CHANGED' : 'ACTOR_CHANGED',
      });
      expect(await orgEffects(org.id)).toEqual(before);
    },
  );

  // Session roles and amr are immutable (0047) and checked once in JS: the edit is refused, the save lands.
  it.each([
    ['roles', 'UPDATE sessions SET roles = \'["user","admin"]\' WHERE id_hash = ?'],
    ['authentication method', "UPDATE sessions SET amr = 'magic_link' WHERE id_hash = ?"],
  ] as const)('cannot change the session %s under a settings save', async (_what, sql) => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    const scope = `org:${org.id}`;
    const sessionId = await hashSessionCookie(tenantUser.cookieValue);
    const saved = await atSettingsCommit(
      async () => {
        await expect(run(appEnv.DB, sql, [sessionId])).rejects.toThrow(
          'session authority is immutable',
        );
      },
      (requestEnv) =>
        call('PUT', '', { scope, values: { 'email.buddy': true } }, tenantUser.headers, requestEnv),
    );
    expect(saved.status).toBe(200);
    expect((await orgEffects(org.id)).settings).toHaveLength(1);
  });

  it.each(['session', 'membership', 'membership replacement'] as const)(
    'fences the complete settings batch when the exact %s is revoked before commit',
    async (revocation) => {
      const org = await makeOrg(fx);
      const membershipId = await addMembership(org.id);
      const scope = `org:${org.id}`;
      const otherSession = await makeSession(fx, { userId: tenantUser.userId });
      expect(
        (
          await call(
            'PUT',
            '',
            {
              scope,
              values: { 'branding.accent': '#123456', 'support.url': 'https://example.com/help' },
            },
            tenantUser.headers,
          )
        ).status,
      ).toBe(200);
      const before = await orgEffects(org.id);
      const sessionId = await hashSessionCookie(tenantUser.cookieValue);

      const denied = await atSettingsCommit(
        async () => {
          if (revocation === 'session') {
            expect(
              await run(appEnv.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
                fx.clock.now(),
                sessionId,
              ]),
            ).toEqual({ changes: 1 });
          } else {
            expect(
              await run(appEnv.DB, 'UPDATE org_memberships SET revoked_at = ? WHERE id = ?', [
                fx.clock.now(),
                membershipId,
              ]),
            ).toEqual({ changes: 1 });
            if (revocation === 'membership replacement') await addMembership(org.id);
          }
        },
        (requestEnv) =>
          call(
            'PUT',
            '',
            {
              scope,
              values: {
                'branding.accent': '#abcdef',
                'support.url': null,
                'email.buddy': true,
              },
            },
            tenantUser.headers,
            requestEnv,
          ),
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'ACTOR_CHANGED' });
      expect(await orgEffects(org.id)).toEqual(before);

      const survivingHeaders = revocation === 'session' ? otherSession.headers : tenantUser.headers;
      const subsequent = await call('GET', `?scope=${scope}`, undefined, survivingHeaders);
      expect(subsequent.status).toBe(revocation === 'membership' ? 403 : 200);
    },
  );
});

describe('client-held config revision', () => {
  it('refuses a save from an older form with 409 and accepts a current or absent revision', async () => {
    const org = await makeOrg(fx);
    await addMembership(org.id);
    const scope = `org:${org.id}`;
    const read = async () =>
      (
        (await (await call('GET', `?scope=${scope}`, undefined, tenantUser.headers)).json()) as {
          configRevision: number;
        }
      ).configRevision;
    const loaded = await read();
    const put = (values: Record<string, unknown>, configRevision?: number) =>
      call(
        'PUT',
        '',
        { scope, values, ...(configRevision === undefined ? {} : { configRevision }) },
        tenantUser.headers,
      );

    // Two admins load the same form; the first saves.
    expect((await put({ 'email.buddy': true }, loaded)).status).toBe(200);
    const stale = await put({ 'email.buddy': false }, loaded);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: 'SETTINGS_CHANGED' });
    expect((await orgEffects(org.id)).settings).toHaveLength(1);

    // The response carries the new revision; /api/v1 clients that send none keep working.
    const current = await read();
    expect(current).toBeGreaterThan(loaded);
    expect((await put({ 'email.buddy': false }, current)).status).toBe(200);
    expect((await put({ 'email.buddy': true })).status).toBe(200);
  });
});

describe('platform settings grant', () => {
  const values = { 'scan.undoWindowMinutes': 17 };
  const stored = () =>
    first<{ value: string }>(
      appEnv.DB,
      "SELECT value FROM settings WHERE scope = 'platform' AND key = 'scan.undoWindowMinutes'",
    );

  it('saves under a live admin session and refuses a revoked or non-admin one', async () => {
    const ctx = createServiceContext(appEnv, { clock: fx.clock });
    const actor = { type: 'user' as const, id: platformAdmin.userId };
    const adminHash = await hashSessionCookie(platformAdmin.cookieValue);
    const before = await stored();

    const tenantHash = await hashSessionCookie(tenantUser.cookieValue);
    await expect(
      updateSettings(
        ctx,
        { type: 'user', id: tenantUser.userId },
        { scope: 'platform', values },
        undefined,
        {
          userId: tenantUser.userId,
          sessionId: tenantHash,
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    expect(await stored()).toEqual(before);

    await updateSettings(ctx, actor, { scope: 'platform', values }, undefined, {
      userId: platformAdmin.userId,
      sessionId: adminHash,
    });
    expect(JSON.parse((await stored())?.value ?? 'null')).toBe(17);

    await run(appEnv.DB, 'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?', [
      fx.clock.now(),
      adminHash,
    ]);
    await expect(
      updateSettings(
        ctx,
        actor,
        { scope: 'platform', values: { 'scan.undoWindowMinutes': 18 } },
        undefined,
        {
          userId: platformAdmin.userId,
          sessionId: adminHash,
        },
      ),
    ).rejects.toMatchObject({ status: 403, code: 'ACTOR_CHANGED' });
    expect(JSON.parse((await stored())?.value ?? 'null')).toBe(17);
  });
});

describe('settings impact', () => {
  it('counts active users who can only sign in by email', async () => {
    const before = ((await (await call('GET', '/impact')).json()) as { emailOnlyUsers: number })
      .emailOnlyUsers;
    const f = fixtures(appEnv);
    await makeUser(f);
    const linked = await makeUser(f);
    await run(
      env.DB,
      "INSERT INTO auth_identities (provider, subject, user_id, created_at) VALUES ('oidc', ?, ?, 1)",
      [`sub-${linked.id}`, linked.id],
    );
    const disabled = await makeUser(f);
    await run(env.DB, "UPDATE users SET status = 'disabled' WHERE id = ?", [disabled.id]);
    await makeUser(f, { primaryEmail: `glass-${f.ids.id()}@wallet.invalid` });
    const res = await call('GET', '/impact');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emailOnlyUsers: before + 1 });
    expect((await call('GET', '/impact', undefined, tenantUser.headers)).status).toBe(403);
  });
});

describe('settings cache', () => {
  it('serves cached values until the ttl, then rereads', async () => {
    const clock = new ManualClock();
    const ctx = createServiceContext(appEnv, { clock });
    expect((await getPlatformSettings(ctx))['refresh.userCooldownSeconds']).toBe(30);
    await run(
      env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'refresh.userCooldownSeconds', '60', 1)",
    );
    expect((await getPlatformSettings(ctx))['refresh.userCooldownSeconds']).toBe(30);
    clock.advance(6000);
    expect((await getPlatformSettings(ctx))['refresh.userCooldownSeconds']).toBe(60);
  });

  it('falls back to the default for a stored value that no longer validates', async () => {
    await run(
      env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'retention.auditDays', '1', 1)",
    );
    const ctx = createServiceContext(appEnv);
    expect((await getPlatformSettings(ctx))['retention.auditDays']).toBe(365);
  });
});
