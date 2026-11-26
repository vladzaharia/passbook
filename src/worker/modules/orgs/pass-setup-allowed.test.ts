import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { makeApiKey, makeOrg, makeSession } from '../../../../test/helpers/index.ts';
import type { PassSetupPatch } from '../../../shared/contracts/pass-setup.ts';
import { createApp } from '../../app.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { systemClock } from '../../platform/clock.ts';
import { all, first, run } from '../../platform/db.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { tenantAuthorityOf } from '../passes/http.ts';
import { clearSettingsCache, getOrgSettings } from '../settings/service.ts';
import { savePlatformCredential } from '../wallet-providers/credential-service.ts';
import { setEnrolmentSource } from '../wallet-providers/enrolment-service.ts';
import { setWalletProvidersEnabledForTest } from '../wallet-providers/provider-policy.ts';
import { addCheck } from '../wallet-providers/repo-wallet-credentials-test-fixtures.ts';
import { type Kit, kit } from '../wallet-providers/wallet-wa1b-test-fixtures.ts';
import { getPassSetup } from './pass-setup.ts';
import { patchPassSetup } from './pass-setup-write.ts';

let k: Kit;
let restore: (() => void) | undefined;
beforeAll(async () => {
  k = await kit();
}, 30_000);
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** An org with an admin in Test mode, on the platform source with a fresh check: ready to enable. */
async function ready(options: { check?: boolean; sandbox?: boolean } = {}) {
  const org = options.sandbox ? await makeOrg(k.f, { kind: 'developer' }) : await k.org();
  if (options.sandbox)
    await run(
      env.DB,
      "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'wallet.google', '1', 1)",
      [org.id],
    );
  const m = await k.member(org.id);
  const admin = await k.admin();
  const row = await first<{ revision: number }>(
    env.DB,
    "SELECT revision FROM wallet_credentials WHERE scope = 'platform' AND mode = 'test' AND provider = 'google' AND revoked_at IS NULL",
  );
  const saved = await savePlatformCredential(k.ctx, admin.auth, {
    mode: 'test',
    provider: 'google',
    expectedRevision: row?.revision ?? 0,
    credentials: k.google('777000111'),
  });
  await setEnrolmentSource(k.ctx, m.auth, org.id, 'google', {
    source: 'platform',
    expectedRevision: 0,
  });
  if (options.check !== false) {
    const version = await first<{ v: string }>(
      env.DB,
      'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
      [saved.id],
    );
    await addCheck(saved.id, version?.v ?? '');
  }
  return { org, m };
}

const save = async (
  org: { id: string },
  auth: AuthContext,
  patch: Omit<PassSetupPatch, 'expectedRevision'>,
  dryRun = false,
) => {
  const { view } = await getPassSetup(k.ctx, auth, org.id);
  const authority = await tenantAuthorityOf(k.ctx, auth, org.id, 'org:manage');
  const actor =
    auth.kind === 'session'
      ? ({ type: 'user', id: auth.userId } as const)
      : ({ type: 'api_key', id: 'key' } as const);
  return patchPassSetup(
    k.ctx,
    actor,
    auth,
    authority,
    org.id,
    { expectedRevision: view.revision, ...patch },
    dryRun,
  );
};
const enrolment = (orgId: string) =>
  first<{ enabled_at: number | null; enrolment_revision: number }>(
    env.DB,
    "SELECT enabled_at, enrolment_revision FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'test' AND provider = 'google'",
    [orgId],
  );
const events = (orgId: string) =>
  all<{ kind: string; actor_type: string; actor_id: string | null }>(
    env.DB,
    `SELECT e.kind, e.actor_type, e.actor_id FROM wallet_enrolment_events e
     JOIN wallet_provider_accounts a ON a.id = e.account_id WHERE a.org_id = ? ORDER BY e.enrolment_revision`,
    [orgId],
  );
const block = async (orgId: string) => {
  await run(
    env.DB,
    'INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
    [`org:${orgId}`, 'channels.blocked', JSON.stringify(['google']), 'test', 1],
  );
  clearSettingsCache(env.DB);
};

describe('Allowed on a wallet channel', () => {
  it('turns the enrolment on in the same batch when the account is ready', async () => {
    restore = setWalletProvidersEnabledForTest(true, 'test');
    const { org, m } = await ready();
    await block(org.id);
    const before = (await getPassSetup(k.ctx, m.auth, org.id)).view;
    expect(before.channels.google).toMatchObject({ allowed: false, on: false });
    expect(before.channels.google.account?.state).toBe('off');

    const dry = await save(org, m.auth, { channels: { google: 'allowed' } }, true);
    expect(dry.impact.enrolments).toEqual(['google']);
    expect(dry.view.channels.google).toMatchObject({ allowed: true, on: true });
    expect(dry.view.channels.google.account?.state).toBe('on');
    expect((await enrolment(org.id))?.enabled_at).toBeNull();

    const done = await save(org, m.auth, { channels: { google: 'allowed' } });
    expect(done.impact.enrolments).toEqual(['google']);
    expect(done.view.channels.google).toMatchObject({ allowed: true, on: true });
    expect((await enrolment(org.id))?.enabled_at).not.toBeNull();
    expect(await events(org.id)).toEqual([
      { kind: 'source', actor_type: 'user', actor_id: m.user.id },
      { kind: 'enable', actor_type: 'user', actor_id: m.user.id },
    ]);
    expect((await getOrgSettings(k.ctx, org.id))['channels.blocked']).toEqual([]);
    const audit = await first<{ detail: string }>(
      env.DB,
      "SELECT detail FROM audit_log WHERE org_id = ? AND action = 'org.pass_setup_update'",
      [org.id],
    );
    expect(JSON.parse(audit?.detail ?? '{}').enrolments).toEqual(['google']);
  });

  it('leaves an account that is not ready off, and the checks say so', async () => {
    restore = setWalletProvidersEnabledForTest(true, 'test');
    const { org, m } = await ready({ check: false });
    await block(org.id);
    const done = await save(org, m.auth, { channels: { google: 'allowed' } });
    expect(done.impact.enrolments).toEqual([]);
    expect((await enrolment(org.id))?.enabled_at).toBeNull();
    expect(done.view.channels.google).toMatchObject({ allowed: true, on: false });
    expect(done.view.channels.google.levels.find((l) => l.level === 'org')).toMatchObject({
      state: 'needs',
      reason: 'not_enrolled',
    });
    expect(done.view.checks.map((c) => c.code)).toContain('WALLET_ACCOUNT');
  });

  it('never enrols a provider the platform has not released', async () => {
    const { org, m } = await ready();
    await block(org.id);
    const done = await save(org, m.auth, { channels: { google: 'allowed' } });
    expect(done.impact.enrolments).toEqual([]);
    expect((await enrolment(org.id))?.enabled_at).toBeNull();
    expect(done.view.channels.google.allowed).toBe(true);
  });

  it('never enrols an org whose plan lacks the wallet', async () => {
    restore = setWalletProvidersEnabledForTest(true, 'test');
    const { org, m } = await ready();
    await block(org.id);
    await run(env.DB, "UPDATE org_entitlements SET preset = 'trial' WHERE org_id = ?", [org.id]);
    const done = await save(org, m.auth, { channels: { google: 'allowed' } });
    expect(done.impact.enrolments).toEqual([]);
    expect((await enrolment(org.id))?.enabled_at).toBeNull();
  });

  it('blocking is a kill switch: the enrolment and its history stay', async () => {
    restore = setWalletProvidersEnabledForTest(true, 'test');
    const { org, m } = await ready();
    await save(org, m.auth, { channels: { google: 'allowed' } });
    const on = await enrolment(org.id);
    expect(on?.enabled_at).not.toBeNull();
    const done = await save(org, m.auth, { channels: { google: 'blocked' } });
    expect(done.view.channels.google).toMatchObject({ allowed: false, on: false });
    expect(await enrolment(org.id)).toEqual(on);
    expect((await events(org.id)).map((e) => e.kind)).toEqual(['source', 'enable']);
  });

  it('an enrolment and the settings commit together or not at all', async () => {
    restore = setWalletProvidersEnabledForTest(true, 'test');
    const { org, m } = await ready();
    await block(org.id);
    await run(
      env.DB,
      `CREATE TRIGGER test_boom_allowed BEFORE INSERT ON settings WHEN NEW.key = 'email.buddy'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    try {
      await expect(
        save(org, m.auth, { channels: { google: 'allowed' }, brand: { email: { buddy: true } } }),
      ).rejects.toThrow();
    } finally {
      await run(env.DB, 'DROP TRIGGER test_boom_allowed');
    }
    expect((await enrolment(org.id))?.enabled_at).toBeNull();
    expect((await events(org.id)).map((e) => e.kind)).toEqual(['source']);
    expect((await getOrgSettings(k.ctx, org.id))['channels.blocked']).toEqual(['google']);
  });
});

/** The HTTP route, with the kit's database and a key made by the kit's fixtures. */
async function patchAs(
  orgId: string,
  scopes: string[],
  body: object,
  mode: 'test' | 'live' = 'test',
  dryRun = false,
) {
  const headers = (await makeApiKey(k.f, { scopes, orgId, mode })).headers;
  const app = createApp({
    stores: {
      ...denyAllStores,
      sessions: createSessionStore(k.env, systemClock),
      apiKeys: createApiKeyStore(k.env, systemClock),
    },
    clock: systemClock,
  });
  const base = `https://wallet.test/api/v1/orgs/${orgId}/pass-setup`;
  const read = await app.request(base, { headers }, k.env);
  const { revision } = (await read.json()) as { revision: string };
  const res = await app.request(
    dryRun ? `${base}?dryRun=true` : base,
    {
      method: 'PATCH',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ expectedRevision: revision, ...body }),
    },
    k.env,
  );
  return {
    status: res.status,
    json: (await res.json()) as { code?: string } & Record<string, any>,
  };
}

describe('who may turn an enrolment on', () => {
  it('an org:write key without wallet:write cannot turn it on', async () => {
    restore = setWalletProvidersEnabledForTest(true, 'test');
    const { org } = await ready({ sandbox: true });
    await block(org.id);
    const refused = await patchAs(org.id, ['org:read', 'org:write'], {
      channels: { google: 'allowed' },
    });
    expect(refused).toMatchObject({ status: 403, json: { code: 'MISSING_SCOPE' } });
    expect((await enrolment(org.id))?.enabled_at).toBeNull();
    expect((await getOrgSettings(k.ctx, org.id))['channels.blocked']).toEqual(['google']);
    // An account that is not ready needs no wallet scope: the switch alone changes.
    const plain = await patchAs(org.id, ['org:read', 'org:write'], {
      channels: { mobile: 'blocked' },
    });
    expect(plain.status).toBe(200);
  });

  it('a wallet:write key alone turns an allowed channel on, attributed to the key, and may do nothing else', async () => {
    restore = setWalletProvidersEnabledForTest(true, 'test');
    const { org } = await ready();
    const done = await patchAs(org.id, ['org:read', 'wallet:write'], {
      channels: { google: 'allowed' },
    });
    expect(done.status).toBe(200);
    expect((await enrolment(org.id))?.enabled_at).not.toBeNull();
    const last = (await events(org.id)).at(-1);
    expect(last).toMatchObject({ kind: 'enable', actor_type: 'api_key' });
    const key = await first(env.DB, 'SELECT 1 AS x FROM api_keys WHERE id = ?', [
      last?.actor_id ?? '',
    ]);
    expect(key).not.toBeNull();
    const rows = await all<{ action: string; actor_type: string }>(
      env.DB,
      `SELECT action, actor_type FROM audit_log WHERE org_id = ?
       AND action IN ('org.pass_setup_update', 'wallet_provider.enrolment_enable') ORDER BY action`,
      [org.id],
    );
    expect(rows).toEqual([
      { action: 'org.pass_setup_update', actor_type: 'api_key' },
      { action: 'wallet_provider.enrolment_enable', actor_type: 'api_key' },
    ]);
    for (const body of [
      { channels: { mobile: 'blocked' } },
      { channels: { google: 'blocked' } },
      { brand: { accent: '#112233' } },
      { brand: { name: 'Nope' }, channels: { google: 'allowed' } },
    ]) {
      const refused = await patchAs(org.id, ['org:read', 'wallet:write'], body);
      expect(refused.status, JSON.stringify(body)).toBe(403);
    }
  });

  it('on an already allowed channel the dry run shows the account the apply turns on', async () => {
    restore = setWalletProvidersEnabledForTest(true, 'test');
    const { org } = await ready();
    const scopes = ['org:read', 'wallet:write'];
    const dry = await patchAs(org.id, scopes, { channels: { google: 'allowed' } }, 'test', true);
    expect(dry.status).toBe(200);
    expect(dry.json.impact.enrolments).toEqual(['google']);
    expect(dry.json.view.channels.google.account.state).toBe('on');
    expect((await enrolment(org.id))?.enabled_at).toBeNull();
    const done = await patchAs(org.id, scopes, { channels: { google: 'allowed' } });
    expect(done.status).toBe(200);
    expect(done.json.impact.enrolments).toEqual(dry.json.impact.enrolments);
    expect(done.json.view.channels.google.account.state).toBe(
      dry.json.view.channels.google.account.state,
    );
  });

  it('a key holding brand:manage and wallet:write still takes the wallet path', async () => {
    restore = setWalletProvidersEnabledForTest(true, 'test');
    const { org } = await ready();
    const done = await patchAs(org.id, ['org:read', 'brand:manage', 'wallet:write'], {
      channels: { google: 'allowed' },
    });
    expect(done.status).toBe(200);
    expect((await enrolment(org.id))?.enabled_at).not.toBeNull();
    const kit = await patchAs(org.id, ['org:read', 'brand:manage', 'wallet:write'], {
      brand: { accent: '#112233' },
    });
    expect(kit).toMatchObject({ status: 403, json: { code: 'MODE_LIVE_REQUIRED' } });
  });

  it('a member with integrations:manage only may turn an account on, nothing else', async () => {
    restore = setWalletProvidersEnabledForTest(true, 'test');
    const { org } = await ready();
    const m = await k.member(org.id, 'test', ['integration_admin']);
    const session = await makeSession(k.f, { userId: m.user.id });
    const headers = { ...session.headers, 'x-passbook-mode': 'test' };
    const app = createApp({
      stores: {
        ...denyAllStores,
        sessions: createSessionStore(k.env, systemClock),
        apiKeys: createApiKeyStore(k.env, systemClock),
      },
      clock: systemClock,
    });
    const url = `https://wallet.test/api/v1/orgs/${org.id}/pass-setup`;
    const send = async (body: object) => {
      const read = await app.request(url, { headers }, k.env);
      const { revision } = (await read.json()) as { revision: string };
      return app.request(
        url,
        {
          method: 'PATCH',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ expectedRevision: revision, ...body }),
        },
        k.env,
      );
    };
    expect((await send({ brand: { accent: '#112233' } })).status).toBe(403);
    expect((await send({ channels: { mobile: 'blocked' } })).status).toBe(403);
    expect((await send({ channels: { google: 'allowed' } })).status).toBe(200);
    expect((await enrolment(org.id))?.enabled_at).not.toBeNull();
    expect((await events(org.id)).at(-1)).toMatchObject({
      kind: 'enable',
      actor_type: 'user',
      actor_id: m.user.id,
    });
  });

  it('a platform key never changes an organization', async () => {
    const { org } = await ready();
    const headers = (await makeApiKey(k.f, { scopes: ['brand:manage'], orgId: null, mode: 'live' }))
      .headers;
    const app = createApp({
      stores: {
        ...denyAllStores,
        sessions: createSessionStore(k.env, systemClock),
        apiKeys: createApiKeyStore(k.env, systemClock),
      },
      clock: systemClock,
    });
    const url = `https://wallet.test/api/v1/orgs/${org.id}`;
    const res = await app.request(
      `${url}/pass-setup`,
      {
        method: 'PATCH',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ expectedRevision: 'x', brand: { accent: '#112233' } }),
      },
      k.env,
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('ORG_FORBIDDEN');
    const stage = await app.request(
      `${url}/brand-assets`,
      {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ slot: 'webLogo', png: 'AAAA' }),
      },
      k.env,
    );
    expect(stage.status).toBe(403);
  });

  it('a Test key changes nothing Live shares, unless the org is a sandbox', async () => {
    const { org } = await ready();
    for (const body of [
      { brand: { accent: '#112233' } },
      { brand: { name: 'Renamed' } },
      { brand: { support: { url: 'https://help.example.com' } } },
      { brand: { support: { email: 'help@acme.test' } } },
      { brand: { email: { fromName: 'Acme' } } },
      { brand: { email: { buddy: true } } },
      { channels: { mobile: 'blocked' } },
    ]) {
      const refused = await patchAs(org.id, ['org:read', 'org:write'], body);
      expect(refused, JSON.stringify(body)).toMatchObject({
        status: 403,
        json: { code: 'MODE_LIVE_REQUIRED' },
      });
    }
    const box = await ready({ sandbox: true });
    for (const body of [
      { brand: { accent: '#112233' } },
      { channels: { mobile: 'blocked' } },
      { brand: { name: 'Renamed' } },
      { brand: { support: { email: 'help@acme.test' } } },
      { brand: { email: { buddy: true } } },
    ])
      expect(
        (await patchAs(box.org.id, ['org:read', 'org:write'], body)).status,
        JSON.stringify(body),
      ).toBe(200);
  });
});
