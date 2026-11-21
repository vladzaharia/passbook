import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PassSetup, PassSetupResult } from '../../../shared/contracts/pass-setup.ts';
import { PassSetupResultSchema } from '../../../shared/contracts/pass-setup.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { clearSettingsCache, getOrgSettings } from '../settings/service.ts';
import { makePng } from '../templates/package/fixtures.ts';
import { type Api, auditOf, setupApi } from '../webhooks/api-test-fixtures.ts';
import { brandingKey, webLogoKey } from './branding-files.ts';
import { BRANDING_GC_GRACE_MS, sweepBrandingGc } from './branding-gc.ts';
import { seedTemplate } from './pass-setup-test-fixtures.ts';

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
    const res = await patch({ brand: { mark: 'none' } });
    expect(res).toMatchObject({ status: 403, json: { code: 'BRAND_MARK_NOT_ALLOWED' } });
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

  it('stages a logo, then a save names it by sha and commits it', async () => {
    const png = makePng(480, 150);
    const sha = await sha256Hex(png);
    const staged = await stage('logo', png);
    expect(staged).toMatchObject({ status: 201, json: { slot: 'logo', sha, w: 480, h: 150 } });
    expect(staged.json.expiresAt).toBeGreaterThan(api.rig.kit.clock.now());
    expect(JSON.parse((await orgRow())?.branding ?? '{}')).toEqual({});
    const dry = await patch({ brand: { logo: { sha } } }, { dryRun: true });
    expect(dry.json.view.brand.logo.value).toEqual({ sha, w: 480, h: 150 });
    const res = await patch({ brand: { logo: { sha } } });
    expect(res.status).toBe(200);
    expect(res.json.diff).toEqual([
      { field: 'brand.logo', before: null, after: { sha, w: 480, h: 150 } },
    ]);
    expect(JSON.parse((await orgRow())?.branding ?? '{}').logo).toEqual({
      sha,
      w: 480,
      h: 150,
      storageVersion: sha,
    });
    expect((await view()).brand.logo).toMatchObject({ source: 'org', value: { sha } });
    expect(res.json.impact.passesToUpdate).toBe(0);
  });

  it('refuses a sha that was never staged, was staged for another slot, or is another org’s', async () => {
    const png = makePng(480, 150);
    const sha = await sha256Hex(png);
    await stage('logo', png);
    for (const body of [
      { brand: { logo: { sha: 'f'.repeat(64) } } },
      { brand: { icon: { sha } } },
      { brand: { webLogo: { sha } } },
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
    const res = await patch({ brand: { logo: { sha } } });
    expect(res.status).toBe(200);
    expect(await exists(brandingKey(other, 'logo', 3, sha))).toBe(true);
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
    const webSha = await sha256Hex(web);
    const iconSha = await sha256Hex(icon);
    await stage('webLogo', web);
    await stage('icon', icon);
    const res = await patch({ brand: { webLogo: { sha: webSha }, icon: { sha: iconSha } } });
    expect(res.status).toBe(200);
    const saved = JSON.parse((await orgRow())?.branding ?? '{}');
    expect(saved.web).toEqual({ sha: webSha, w: 400, h: 100 });
    expect(saved.icon).toMatchObject({ sha: iconSha, storageVersion: iconSha });
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
    const used = makePng(480, 150);
    const lost = makePng(300, 90);
    const [usedSha, lostSha] = await Promise.all([sha256Hex(used), sha256Hex(lost)]);
    await stage('logo', used);
    await stage('logo', lost);
    await stage('webLogo', makePng(400, 100));
    const res = await patch({ brand: { logo: { sha: usedSha } } });
    expect(res.status).toBe(200);
    const usedKey = brandingKey(orgId, 'logo', 3, usedSha);
    const lostKey = brandingKey(orgId, 'logo', 3, lostSha);
    await sweep(BRANDING_GC_GRACE_MS - 60_000);
    expect(await exists(lostKey)).toBe(true);
    await sweep(60_000 + 1);
    expect(await exists(usedKey)).toBe(true);
    expect(await exists(lostKey)).toBe(false);
    expect(await exists(webLogoKey(orgId, await sha256Hex(makePng(400, 100))))).toBe(false);
    expect(
      await all(api.rig.db, 'SELECT 1 FROM branding_gc_queue WHERE org_id = ?', [orgId]),
    ).toEqual([]);
    // A save after the sweep finds it gone.
    admin = await api.member(['org_admin']);
    const late = await patch({ brand: { logo: { sha: lostSha } } });
    expect(late.json.code).toBe('BRAND_ASSET_NOT_FOUND');
  });

  it('a replaced logo is queued and swept like any superseded one', async () => {
    const first = makePng(480, 150);
    const second = makePng(300, 90);
    const [a, b] = await Promise.all([sha256Hex(first), sha256Hex(second)]);
    await stage('logo', first);
    expect((await patch({ brand: { logo: { sha: a } } })).status).toBe(200);
    await stage('logo', second);
    expect((await patch({ brand: { logo: { sha: b } } })).status).toBe(200);
    await sweep();
    expect(
      await all(
        api.rig.db,
        'SELECT r2_key, superseded_at FROM branding_gc_queue WHERE org_id = ?',
        [orgId],
      ),
    ).toEqual([]);
    admin = await api.member(['org_admin']);
    expect(await exists(brandingKey(orgId, 'logo', 3, a))).toBe(false);
    expect(await exists(brandingKey(orgId, 'logo', 3, b))).toBe(true);
  });
});
