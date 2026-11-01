import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeAuth, fixtures, makeEnv, makeOrg, makeUser } from '../../../../test/helpers/index.ts';
import { createApp } from '../../app.ts';
import { ManualClock } from '../../platform/clock.ts';
import { all, run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { clearSettingsCache, getOrgSettings, getPlatformSettings } from './service.ts';

const fake = fakeAuth();
let appEnv: AppEnv;
const app = createApp({ stores: fake.stores });
const call = (method: string, path: string, body?: unknown, headers = fake.admin()) =>
  app.request(
    `/api/v1/settings${path}`,
    {
      method,
      headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    },
    appEnv,
  );

type List = {
  items: { key: string; value: unknown; default?: unknown }[];
  oidc: { issuer: string };
};

beforeAll(async () => {
  appEnv = await makeEnv();
});
beforeEach(async () => {
  await run(env.DB, 'DELETE FROM settings');
  await run(env.DB, 'DELETE FROM audit_log');
  clearSettingsCache(env.DB);
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
    const org = await makeOrg(fixtures(appEnv));
    const put = (values: object) => call('PUT', '', { scope: `org:${org.id}`, values });
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
    expect(body.oidc.issuer).toBe(appEnv.OIDC_ISSUER);
  });

  it('updates, audits the diff, and resets with null', async () => {
    const put = await call('PUT', '', { values: { 'retention.auditDays': 90 } });
    expect(put.status).toBe(200);
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

  it('rejects the system scope and unknown org scopes', async () => {
    expect((await call('GET', '?scope=system')).status).toBe(422);
    expect((await call('GET', '?scope=org:missing')).status).toBe(404);
    expect((await call('PUT', '', { scope: 'org:missing', values: {} })).status).toBe(404);
  });

  it('keeps org settings apart from platform and other orgs', async () => {
    const f = fixtures(appEnv);
    const a = await makeOrg(f);
    const b = await makeOrg(f);
    const res = await call('PUT', '', {
      scope: `org:${a.id}`,
      values: { 'branding.accent': '#aabbcc' },
    });
    expect(res.status).toBe(200);
    expect(
      (await call('PUT', '', { scope: `org:${a.id}`, values: { 'branding.accent': 'red' } }))
        .status,
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

  it('requires an admin', async () => {
    expect((await call('GET', '', undefined, fake.user())).status).toBe(403);
    expect((await call('PUT', '', { values: {} }, fake.user())).status).toBe(403);
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
    expect((await call('GET', '/impact', undefined, fake.user())).status).toBe(403);
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
