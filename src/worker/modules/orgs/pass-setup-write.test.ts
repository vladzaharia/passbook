import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PassSetup, PassSetupResult } from '../../../shared/contracts/pass-setup.ts';
import { PassSetupResultSchema } from '../../../shared/contracts/pass-setup.ts';
import { createApp } from '../../app.ts';
import { denyAllStores } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { createApiKeyStore } from '../api-keys/service.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { clearSettingsCache, getOrgSettings } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { type Api, auditOf, setupApi } from '../webhooks/api-test-fixtures.ts';
import { orgBrandOf } from './brand.ts';
import { brandingKey, webLogoKey } from './branding-files.ts';
import { BRANDING_GC_GRACE_MS, sweepBrandingGc } from './branding-gc.ts';
import { seedTemplate, setSetting } from './pass-setup-test-fixtures.ts';

let api: Api;
let orgId: string;
let admin: Record<string, string>;
let orgWrite: Record<string, string>;
const base = () => `/api/v1/orgs/${orgId}/pass-setup`;
const ctx = () => createServiceContext(api.rig.kit.env, { clock: api.rig.kit.clock });

beforeAll(async () => {
  api = await setupApi();
  orgId = api.rig.orgId;
  admin = await api.member(['org_admin']);
  orgWrite = await api.key({ scopes: ['org:read', 'org:write'] });
});
// The GC tests move the clock a day on: sign in again for each test.
beforeEach(async () => {
  admin = await api.member(['org_admin']);
  orgWrite = await api.key({ scopes: ['org:read', 'org:write'] });
});
afterEach(async () => {
  await run(api.rig.db, "UPDATE orgs SET branding = '{}', name = 'Test Gym' WHERE id = ?", [orgId]);
  await run(api.rig.db, 'DELETE FROM settings WHERE scope = ?', [`org:${orgId}`]);
  await run(api.rig.db, "DELETE FROM org_entitlement_overrides WHERE key = 'brand.mark'");
  await run(api.rig.db, 'DELETE FROM audit_log WHERE action = ?', ['org.pass_setup_update']);
  await run(api.rig.db, 'DELETE FROM branding_gc_queue');
  await run(api.rig.db, 'DROP TRIGGER IF EXISTS test_boom');
  clearSettingsCache(api.rig.db);
});

const view = async (headers = admin) =>
  (await api.call('GET', base(), undefined, headers)).json as PassSetup;
const patch = async (
  body: object,
  options: { headers?: Record<string, string>; dryRun?: boolean; revision?: string } = {},
) => {
  const headers = options.headers ?? admin;
  const expectedRevision = options.revision ?? (await view(headers)).revision;
  return api.call(
    'PATCH',
    `${base()}${options.dryRun ? '?dryRun=true' : ''}`,
    { expectedRevision, ...body },
    headers,
  );
};
const orgRow = () =>
  first<{ name: string; branding: string; config_revision: number }>(
    api.rig.db,
    'SELECT name, branding, config_revision FROM orgs WHERE id = ?',
    [orgId],
  );
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const stage = (slot: string, png: Uint8Array, headers = admin, org = orgId) =>
  api.call('POST', `/api/v1/orgs/${org}/brand-assets`, { slot, png: b64(png) }, headers);

/** Stages a PNG and answers the reference a save names it by. */
const ref = async (slot: string, png: Uint8Array, headers = admin, org = orgId) => {
  const res = await stage(slot, png, headers, org);
  return { sha: res.json.sha as string, version: res.json.version as string };
};

describe('PATCH pass-setup: input and scopes', () => {
  it('refuses an empty change and an unknown field', async () => {
    const empty = await patch({});
    expect(empty).toMatchObject({ status: 422, json: { code: 'PASS_SETUP_EMPTY' } });
    expect((await patch({ brand: {} })).json.code).toBe('PASS_SETUP_EMPTY');
    expect((await patch({ brand: { nope: 1 } })).status).toBe(422);
  });

  it('answers 409 PASS_SETUP_CHANGED on a stale revision and writes nothing', async () => {
    const res = await patch({ brand: { accent: '#112233' } }, { revision: 'live.0.0.0' });
    expect(res).toMatchObject({ status: 409, json: { code: 'PASS_SETUP_CHANGED' } });
    expect(JSON.parse((await orgRow())?.branding ?? '{}')).toEqual({});
  });

  it('a brand:manage key changes the brand kit only; org:write changes the rest', async () => {
    const brand = await api.key({ scopes: ['org:read', 'brand:manage'] });
    const kit = await patch({ brand: { accent: '#112233' } }, { headers: brand });
    expect(kit.status).toBe(200);
    for (const body of [
      { channels: { mobile: 'blocked' } },
      { brand: { name: 'Renamed' } },
      { brand: { support: { url: 'https://help.example.com' } } },
      { brand: { email: { buddy: true } } },
    ]) {
      const res = await patch(body, { headers: brand });
      expect(res, JSON.stringify(body)).toMatchObject({
        status: 403,
        json: { code: 'MISSING_SCOPE' },
      });
    }
    expect((await patch({ brand: { name: 'Renamed' } }, { headers: orgWrite })).status).toBe(200);
  });

  it('refuses a read-only key, a member without org:manage and another org’s key', async () => {
    const readOnly = await api.key({ scopes: ['org:read'] });
    expect((await patch({ brand: { accent: '#112233' } }, { headers: readOnly })).status).toBe(403);
    const publisher = await api.member(['template_publisher']);
    const res = await api.call(
      'PATCH',
      base(),
      { expectedRevision: (await view()).revision, brand: { accent: '#112233' } },
      publisher,
    );
    expect(res.status).toBe(403);
    const other = await api.otherOrg();
    const foreign = await api.key({ scopes: ['org:write'], orgId: other });
    const cross = await api.call(
      'PATCH',
      base(),
      { expectedRevision: 'x', brand: { accent: '#112233' } },
      foreign,
    );
    expect(cross).toMatchObject({ status: 403, json: { code: 'ORG_FORBIDDEN' } });
    expect(JSON.parse((await orgRow())?.branding ?? '{}')).toEqual({});
  });

  it('refuses a mark the plan does not allow', async () => {
    // Unlimited (the rig's plan) can drop the footer; Standard can only shrink it.
    const plan = (preset: string) =>
      run(api.rig.db, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [preset, orgId]);
    await plan('standard');
    try {
      const res = await patch({ brand: { mark: 'none' } });
      expect(res).toMatchObject({ status: 403, json: { code: 'BRAND_MARK_NOT_ALLOWED' } });
    } finally {
      await plan('legacy');
    }
  });

  it('refuses invalid settings as the settings route does', async () => {
    const own = await patch({ brand: { email: { fromName: 'PassBook' } } });
    expect(own).toMatchObject({ status: 422, json: { code: 'VALIDATION' } });
    const platform = await patch({
      brand: { support: { email: `help@${new URL(api.rig.kit.env.PUBLIC_BASE_URL).hostname}` } },
    });
    expect(platform).toMatchObject({ status: 422, json: { code: 'INVALID_SETTING' } });
    expect(await auditOf(api.rig.db, 'org.pass_setup_update')).toHaveLength(0);
  });
});

describe('PATCH pass-setup: dry run and apply', () => {
  // The change picks the small footer: the plan must allow it.
  beforeEach(async () => {
    await run(
      api.rig.db,
      "INSERT INTO org_entitlement_overrides (org_id, key, value, updated_at) VALUES (?, 'brand.mark', '\"quiet\"', 1)",
      [orgId],
    );
  });
  const change = {
    brand: {
      name: 'Acme Fitness',
      accent: '#2563eb',
      passColors: { background: '#0f172a', foreground: '#ffffff', label: '#fbbf24' },
      logoHasName: true,
      mark: 'small',
      support: { email: 'help@acme.test', url: 'https://acme.test/help' },
      email: { buddy: true },
      webLogoSameAsLogo: false,
    },
    channels: { mobile: 'blocked', nfc: 'blocked' },
  };

  it('a dry run writes nothing and answers with the change, the diff and the impact', async () => {
    await seedTemplate(api, orgId, 'tpl_x');
    const before = await orgRow();
    const res = await patch(change, { dryRun: true });
    expect(res.status).toBe(200);
    const body = PassSetupResultSchema.parse(res.json);
    expect(body.dryRun).toBe(true);
    expect(body.diff.map((d) => d.field).sort()).toEqual(
      [
        'brand.name',
        'brand.accent',
        'brand.passColors',
        'brand.logoHasName',
        'brand.mark',
        'brand.support.email',
        'brand.support.url',
        'brand.email.buddy',
        'brand.webLogoSameAsLogo',
        'channels.mobile',
        'channels.nfc',
      ].sort(),
    );
    expect(body.diff.find((d) => d.field === 'channels.mobile')).toMatchObject({
      before: 'allowed',
      after: 'blocked',
    });
    expect(body.impact.channelStops).toEqual([
      { channel: 'mobile', templates: 1, passes: 0 },
      { channel: 'nfc', templates: 1, passes: 0 },
    ]);
    expect(body.view.brand.name.value).toBe('Acme Fitness');
    expect(body.view.channels.mobile).toMatchObject({ allowed: false, on: false });
    expect(await orgRow()).toEqual(before);
    expect(await auditOf(api.rig.db, 'org.pass_setup_update')).toHaveLength(0);
    expect(
      await all(api.rig.db, 'SELECT 1 FROM settings WHERE scope = ?', [`org:${orgId}`]),
    ).toEqual([]);
  });

  it('an apply writes it all, and its view equals the dry run’s', async () => {
    const dry = (await patch(change, { dryRun: true })).json as PassSetupResult;
    const res = await patch(change);
    expect(res.status).toBe(200);
    const done = PassSetupResultSchema.parse(res.json);
    expect(done.dryRun).toBe(false);
    expect(done.diff).toEqual(dry.diff);
    const strip = (v: PassSetup) => ({ ...v, revision: '' });
    expect(strip(done.view)).toEqual(strip(dry.view));
    const row = await orgRow();
    expect(row?.name).toBe('Acme Fitness');
    expect(JSON.parse(row?.branding ?? '{}')).toMatchObject({
      accent: '#2563eb',
      logoHasName: true,
      mark: 'small',
      passColors: { background: '#0f172a' },
    });
    const settings = await getOrgSettings(ctx(), orgId);
    expect(settings).toMatchObject({
      'support.email': 'help@acme.test',
      'support.url': 'https://acme.test/help',
      'email.buddy': true,
      'branding.webLogoSameAsLogo': false,
      'channels.blocked': ['mobile', 'nfc'],
      'nfc.tags': { enabled: false },
    });
    expect(done.view.checks.map((c) => c.code)).not.toContain('SUPPORT_MISSING');
  });

  it('writes one audit row with the diff', async () => {
    await patch(change);
    const rows = await auditOf(api.rig.db, 'org.pass_setup_update');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: orgId, actor_type: 'user', target_id: orgId });
    const detail = JSON.parse(rows[0]?.detail ?? '{}');
    expect(detail.changes['brand.name']).toEqual({ from: 'Test Gym', to: 'Acme Fitness' });
    expect(detail.changes['channels.mobile']).toEqual({ from: 'allowed', to: 'blocked' });
    const viaKey = await patch({ brand: { accent: '#445566' } }, { headers: orgWrite });
    expect(viaKey.status).toBe(200);
    expect((await auditOf(api.rig.db, 'org.pass_setup_update')).at(-1)?.actor_type).toBe('api_key');
  });

  it('allowing again removes the block, and NFC turns its tags back on', async () => {
    await patch(change);
    const res = await patch({ channels: { mobile: 'allowed', nfc: 'allowed' } });
    expect(res.status).toBe(200);
    expect(await getOrgSettings(ctx(), orgId)).toMatchObject({
      'channels.blocked': [],
      'nfc.tags': { enabled: true },
    });
    expect(res.json.view.channels.mobile.on).toBe(true);
  });

  it('switching a channel off never retires copies or starts a channel run', async () => {
    const tables = ['pass_channels', 'pass_channel_copies', 'channel_apply_runs'];
    const count = async () =>
      Promise.all(
        tables.map(
          async (t) =>
            (await first<{ n: number }>(api.rig.db, `SELECT count(*) AS n FROM ${t}`))?.n,
        ),
      );
    const before = await count();
    await patch({ channels: { apple: 'blocked', mobile: 'blocked' } });
    expect(await count()).toEqual(before);
  });

  it('a change that does nothing writes nothing', async () => {
    const res = await patch({ channels: { mobile: 'allowed' }, brand: { accent: null } });
    expect(res.status).toBe(200);
    expect(res.json.diff).toEqual([]);
    expect(await auditOf(api.rig.db, 'org.pass_setup_update')).toHaveLength(1);
  });

  it('clearing the support address also clears the one an older save kept in the branding', async () => {
    await run(api.rig.db, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({ supportEmail: 'old@acme.test' }),
      orgId,
    ]);
    expect((await view()).brand.support.email.value).toBe('old@acme.test');
    const res = await patch({ brand: { support: { email: null } } });
    expect(res.json.view.brand.support.email).toEqual({ value: null, source: 'passbook' });
    expect(JSON.parse((await orgRow())?.branding ?? '{}')).toEqual({});
  });
});

describe('an org:write key', () => {
  it('renames the org, audited with the key as the actor', async () => {
    const res = await patch({ brand: { name: 'Keyed Gym' } }, { headers: orgWrite });
    expect(res.status).toBe(200);
    const [row] = await all<{ actor_type: string; actor_id: string | null; detail: string }>(
      api.rig.db,
      "SELECT actor_type, actor_id, detail FROM audit_log WHERE action = 'org.pass_setup_update'",
    );
    expect(row?.actor_type).toBe('api_key');
    expect(row?.actor_id).toBeTruthy();
    expect(JSON.parse(row?.detail ?? '{}').changes['brand.name']).toEqual({
      from: 'Test Gym',
      to: 'Keyed Gym',
    });
  });
});

describe('the web logo follows the pass logo', () => {
  const brandOf = () => orgBrandOf(ctx(), orgId);
  const fetchLogo = async (path: string) => {
    const app = createApp({
      stores: {
        ...denyAllStores,
        sessions: createSessionStore(api.rig.kit.env, api.rig.kit.clock),
        apiKeys: createApiKeyStore(api.rig.kit.env, api.rig.kit.clock),
      },
      clock: api.rig.kit.clock,
    });
    return app.request(`https://wallet.test${path}`, {}, api.rig.kit.env);
  };

  it('is the pass logo while no web logo exists, and serves its bytes', async () => {
    const png = makePng(480, 150);
    const { sha, version } = await ref('logo', png);
    await patch({ brand: { logo: { sha, version } } });
    const brand = await brandOf();
    expect(brand.logo?.path).toBe(`/brand/${orgId}/${sha}.png`);
    const res = await fetchLogo(brand.logo?.path ?? '');
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    expect((await fetchLogo(`/brand/${orgId}/${'0'.repeat(64)}.png`)).status).toBe(404);
    expect((await view()).brand.webLogo.sameAsLogo).toBe(true);
  });

  it('a web logo wins until the org chooses the pass logo, and off means the web logo only', async () => {
    const logo = makePng(480, 150);
    const web = makePng(400, 100);
    const l = await ref('logo', logo);
    const w = await ref('webLogo', web);
    const [logoSha, webSha] = [l.sha, w.sha];
    await patch({ brand: { logo: l, webLogo: w } });
    expect((await brandOf()).logo?.path).toBe(`/brand/${orgId}/${webSha}.png`);
    expect((await view()).brand.webLogo.sameAsLogo).toBe(false);
    await patch({ brand: { webLogoSameAsLogo: true } });
    expect((await brandOf()).logo?.path).toBe(`/brand/${orgId}/${logoSha}.png`);
    await patch({ brand: { webLogoSameAsLogo: false, webLogo: null } });
    expect((await brandOf()).logo).toBeNull();
  });
});

describe('PATCH pass-setup: snapshot, caps and scopes', () => {
  it('plans from the settings read with the revision, not from a cache another writer left', async () => {
    // Prime this isolate's settings cache with no block, as a request seconds ago would have.
    await setSetting(api, `org:${orgId}`, 'channels.blocked', []);
    await view();
    // Another writer blocks Apple straight in D1 (which moves config_revision).
    await run(
      api.rig.db,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, 'channels.blocked', '[\"apple\"]', 'x', 1)",
      [`org:${orgId}`],
    );
    const row = await orgRow();
    const revision = `live.${row?.config_revision}.0.0`;
    const res = await patch({ channels: { samsung: 'blocked' } }, { revision });
    expect(res.status).toBe(200);
    expect((await getOrgSettings(ctx(), orgId))['channels.blocked']).toEqual(['apple', 'samsung']);
  });

  it('mails at most five reply-to confirmations a day; the rest wait pending', async () => {
    for (let i = 0; i < 7; i++) {
      const res = await patch(
        { brand: { support: { email: `help${i}@acme.test` } } },
        { headers: orgWrite },
      );
      expect(res.status).toBe(200);
    }
    const pending = await first<{ address: string }>(
      api.rig.db,
      'SELECT address FROM org_reply_to WHERE org_id = ?',
      [orgId],
    );
    expect(pending?.address).toBe('help6@acme.test');
    const sent = await first<{ n: number }>(
      api.rig.db,
      'SELECT count FROM counters WHERE key = ? ORDER BY window_start DESC LIMIT 1',
      [`reply-to-confirm:${orgId}`],
    ).then((r) => r as unknown as { count: number } | null);
    expect(sent?.count).toBe(5);
  });

  it('a key holding only wallet:write gets 403 on everything else', async () => {
    const wallet = await api.key({ scopes: ['wallet:write'] });
    const other = await api.otherOrg();
    for (const [method, path, body] of [
      ['GET', base(), undefined],
      ['PATCH', base(), { expectedRevision: 'x', brand: { accent: '#112233' } }],
      ['POST', `/api/v1/orgs/${orgId}/brand-assets`, { slot: 'logo', png: 'AAAA' }],
      ['GET', '/api/v1/passes', undefined],
      ['GET', `/api/v1/orgs/${orgId}/entitlements`, undefined],
      ['PUT', '/api/v1/brand/web-logo', { png: 'AAAA' }],
    ] as const) {
      const res = await api.call(method, path, body, wallet);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    void other;
  });
});

describe('PATCH pass-setup: one batch', () => {
  it('a failing settings write leaves the org row, the settings and the audit untouched', async () => {
    await run(
      api.rig.db,
      `CREATE TRIGGER test_boom BEFORE INSERT ON settings WHEN NEW.key = 'email.buddy'
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    const before = await orgRow();
    const res = await patch({
      brand: { name: 'Acme Fitness', accent: '#2563eb', email: { buddy: true } },
      channels: { mobile: 'blocked' },
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(await orgRow()).toEqual(before);
    expect(
      await all(api.rig.db, 'SELECT 1 FROM settings WHERE scope = ?', [`org:${orgId}`]),
    ).toEqual([]);
    expect(await auditOf(api.rig.db, 'org.pass_setup_update')).toHaveLength(0);
  });

  it('a save made from a revision that moved meanwhile is refused inside the batch', async () => {
    const stale = (await view()).revision;
    await run(api.rig.db, "UPDATE orgs SET name = 'Moved' WHERE id = ?", [orgId]);
    const res = await patch({ brand: { accent: '#2563eb' } }, { revision: stale });
    expect(res).toMatchObject({ status: 409, json: { code: 'PASS_SETUP_CHANGED' } });
  });
});

describe('PATCH pass-setup: Idempotency-Key', () => {
  const send = (body: object, key: string, query = '') =>
    api.call('PATCH', `${base()}${query}`, body, { ...admin, 'idempotency-key': key });

  it('a replay returns the first result and writes once', async () => {
    const body = { expectedRevision: (await view()).revision, brand: { name: 'Once' } };
    const first = await send(body, 'k-1');
    const again = await send(body, 'k-1');
    expect(first.status).toBe(200);
    expect(again.json).toEqual(first.json);
    expect(await auditOf(api.rig.db, 'org.pass_setup_update')).toHaveLength(1);
    const other = await send({ ...body, brand: { name: 'Twice' } }, 'k-1');
    expect(other).toMatchObject({ status: 422, json: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('a dry run takes no key: the apply with the same one still runs', async () => {
    const body = { expectedRevision: (await view()).revision, brand: { name: 'Dry' } };
    const dry = await send(body, 'k-2', '?dryRun=true');
    expect(dry.json.dryRun).toBe(true);
    expect((await orgRow())?.name).toBe('Test Gym');
    const real = await send(body, 'k-2');
    expect(real.json.dryRun).toBe(false);
    expect((await orgRow())?.name).toBe('Dry');
  });
});

describe('staged brand assets', () => {
  const sweep = async (ms = BRANDING_GC_GRACE_MS) => {
    api.rig.kit.clock.advance(ms);
    await sweepBrandingGc(ctx());
  };
  const exists = async (key: string) => (await api.rig.kit.env.BUCKET.head(key)) !== null;

  it('stages a logo, then a save names it by sha and version and commits it', async () => {
    const png = makePng(480, 150);
    const sha = await sha256Hex(png);
    const staged = await stage('logo', png);
    expect(staged).toMatchObject({ status: 201, json: { slot: 'logo', sha, w: 480, h: 150 } });
    const version = staged.json.version as string;
    expect(staged.json.expiresAt).toBeGreaterThan(api.rig.kit.clock.now());
    expect(JSON.parse((await orgRow())?.branding ?? '{}')).toEqual({});
    const named = { sha, version };
    const dry = await patch({ brand: { logo: named } }, { dryRun: true });
    expect(dry.json.view.brand.logo.value).toEqual({ sha, w: 480, h: 150 });
    const res = await patch({ brand: { logo: named } });
    expect(res.status).toBe(200);
    expect(res.json.diff).toEqual([
      { field: 'brand.logo', before: null, after: { sha, w: 480, h: 150 } },
    ]);
    expect(JSON.parse((await orgRow())?.branding ?? '{}').logo).toEqual({
      sha,
      w: 480,
      h: 150,
      storageVersion: version,
    });
    expect((await view()).brand.logo).toMatchObject({ source: 'org', value: { sha } });
    expect(res.json.impact.passesToUpdate).toBe(0);
  });

  it('staging never replaces a file a pass uses: another @2x is another version', async () => {
    const png = makePng(480, 150);
    const first = await ref('logo', png);
    await patch({ brand: { logo: first } });
    const live = brandingKey(orgId, 'logo', 2, first.version);
    const before = await (await api.rig.kit.env.BUCKET.get(live))?.arrayBuffer();
    const other = makePng(320, 100);
    const res = await api.call(
      'POST',
      `/api/v1/orgs/${orgId}/brand-assets`,
      { slot: 'logo', png: b64(png), x2: b64(other) },
      admin,
    );
    expect(res.status).toBe(201);
    expect(res.json.sha).toBe(first.sha);
    expect(res.json.version).not.toBe(first.version);
    expect(await (await api.rig.kit.env.BUCKET.get(live))?.arrayBuffer()).toEqual(before);
  });

  it('refuses a sha that was never staged, was staged for another slot, or is another org’s', async () => {
    const png = makePng(480, 150);
    const named = await ref('logo', png);
    for (const body of [
      { brand: { logo: { sha: 'f'.repeat(64) } } },
      { brand: { logo: { sha: named.sha, version: 'e'.repeat(64) } } },
      { brand: { icon: named } },
      { brand: { webLogo: { sha: named.sha } } },
    ]) {
      const res = await patch(body);
      expect(res, JSON.stringify(body)).toMatchObject({
        status: 422,
        json: { code: 'BRAND_ASSET_NOT_FOUND' },
      });
    }
    const other = await api.otherOrg();
    const foreign = await api.member(['org_admin'], { orgId: other });
    await stage('logo', png, foreign, other);
    const res = await patch({ brand: { logo: named } });
    expect(res.status).toBe(200);
    expect(await exists(brandingKey(other, 'logo', 3, named.version))).toBe(true);
  });

  it('checks the PNG when staging', async () => {
    const tiny = await stage('logo', makePng(1500, 400));
    expect([tiny.status, tiny.json.code]).toEqual([422, 'IMAGE_SIZE']);
    expect((await stage('webLogo', new Uint8Array([1, 2, 3, 4]))).json.code).toBe('IMAGE_INVALID');
    expect((await stage('nope', makePng(480, 150))).status).toBe(422);
    const readOnly = await api.key({ scopes: ['org:read'] });
    expect((await stage('logo', makePng(480, 150), readOnly)).status).toBe(403);
  });

  it('stages a web logo and an icon; clearing a slot is null', async () => {
    const web = makePng(400, 100);
    const icon = makePng(114, 114);
    const w = await ref('webLogo', web);
    const i = await ref('icon', icon);
    const [webSha, iconSha] = [w.sha, i.version];
    const res = await patch({ brand: { webLogo: w, icon: i } });
    expect(res.status).toBe(200);
    const saved = JSON.parse((await orgRow())?.branding ?? '{}');
    expect(saved.web).toEqual({ sha: webSha, w: 400, h: 100 });
    expect(saved.icon).toMatchObject({ sha: i.sha, storageVersion: iconSha });
    const cleared = await patch({ brand: { webLogo: null, icon: null } });
    expect(cleared.json.diff.map((d: { field: string }) => d.field)).toEqual([
      'brand.icon',
      'brand.webLogo',
    ]);
    expect(JSON.parse((await orgRow())?.branding ?? '{}')).toEqual({});
  });

  it('caps what an org may leave waiting', async () => {
    for (let i = 0; i < 100; i++)
      await run(
        api.rig.db,
        'INSERT INTO branding_gc_queue (org_id, r2_key, superseded_at) VALUES (?, ?, 1)',
        [orgId, `k${i}`],
      );
    expect((await stage('logo', makePng(480, 150))).status).toBe(429);
  });

  it('the sweep deletes an unreferenced staged asset after the grace period, never a referenced one', async () => {
    const used = await ref('logo', makePng(480, 150));
    const lost = await ref('logo', makePng(300, 90));
    const web = await ref('webLogo', makePng(400, 100));
    const res = await patch({ brand: { logo: used } });
    expect(res.status).toBe(200);
    const usedKey = brandingKey(orgId, 'logo', 3, used.version);
    const lostKey = brandingKey(orgId, 'logo', 3, lost.version);
    // Staged keys wait an hour past the advertised expiry.
    await sweep(BRANDING_GC_GRACE_MS);
    expect(await exists(lostKey)).toBe(true);
    await sweep(3_600_000 + 1);
    expect(await exists(usedKey)).toBe(true);
    expect(await exists(lostKey)).toBe(false);
    expect(await exists(webLogoKey(orgId, web.sha))).toBe(false);
    expect(
      await all(api.rig.db, 'SELECT 1 FROM branding_gc_queue WHERE org_id = ?', [orgId]),
    ).toEqual([]);
    // A save after the sweep finds it gone.
    admin = await api.member(['org_admin']);
    const late = await patch({ brand: { logo: lost } });
    expect(late.json.code).toBe('BRAND_ASSET_NOT_FOUND');
  });

  it('a save that names a key the sweep claimed meanwhile keeps it', async () => {
    const named = await ref('logo', makePng(480, 150));
    const key = brandingKey(orgId, 'logo', 3, named.version);
    // The save re-queues the key right before it commits; a sweep that claimed the old row finds that row.
    expect((await patch({ brand: { logo: named } })).status).toBe(200);
    await run(
      api.rig.db,
      'INSERT OR REPLACE INTO branding_gc_queue (org_id, r2_key, superseded_at) VALUES (?, ?, 1)',
      [orgId, key],
    );
    await sweepBrandingGc(ctx());
    expect(await exists(key)).toBe(true);
  });

  it('a replaced logo is queued and swept like any superseded one', async () => {
    const a = await ref('logo', makePng(480, 150));
    expect((await patch({ brand: { logo: a } })).status).toBe(200);
    const b = await ref('logo', makePng(300, 90));
    expect((await patch({ brand: { logo: b } })).status).toBe(200);
    await sweep(BRANDING_GC_GRACE_MS + 3_600_000);
    expect(
      await all(
        api.rig.db,
        'SELECT r2_key, superseded_at FROM branding_gc_queue WHERE org_id = ?',
        [orgId],
      ),
    ).toEqual([]);
    admin = await api.member(['org_admin']);
    expect(await exists(brandingKey(orgId, 'logo', 3, a.version))).toBe(false);
    expect(await exists(brandingKey(orgId, 'logo', 3, b.version))).toBe(true);
  });
});
