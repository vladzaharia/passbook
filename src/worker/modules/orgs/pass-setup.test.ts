import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PassSetup } from '../../../shared/contracts/pass-setup.ts';
import { PassSetupSchema } from '../../../shared/contracts/pass-setup.ts';
import { run } from '../../platform/db.ts';
import { setWalletProvidersEnabledForTest } from '../wallet-providers/provider-policy.ts';
import { type Api, setupApi } from '../webhooks/api-test-fixtures.ts';
import { orgWith, seedTemplate, setSetting } from './pass-setup-test-fixtures.ts';

let api: Api;
let orgId: string;
let admin: Record<string, string>;
const restore: (() => void)[] = [];

beforeAll(async () => {
  api = await setupApi();
  orgId = api.rig.orgId;
  admin = await api.member(['org_admin']);
});
afterEach(async () => {
  for (const undo of restore.splice(0)) undo();
  await setSetting(api, 'platform', 'print.enabled', true);
  await setSetting(api, 'platform', 'nfc.tagsEnabled', true);
  await setSetting(api, `org:${orgId}`, 'channels.blocked', []);
  await setSetting(api, `org:${orgId}`, 'nfc.tags', { enabled: true });
});

const read = async (headers = admin, org = orgId) => {
  const res = await api.call('GET', `/api/v1/orgs/${org}/pass-setup`, undefined, headers);
  return { ...res, view: res.json as PassSetup };
};
const level = (view: PassSetup, channel: keyof PassSetup['channels'], name: string) =>
  view.channels[channel].levels.find((l) => l.level === name);

describe('GET pass-setup', () => {
  it('answers the caller’s view of a new org, in the schema', async () => {
    const { status, view, json } = await read();
    expect(status).toBe(200);
    expect(PassSetupSchema.safeParse(json).success).toBe(true);
    expect(view).toMatchObject({
      orgId,
      mode: 'live',
      passCount: 0,
      brand: { logo: { value: null, source: 'passbook' }, mark: { effective: 'full' } },
      apple: { identity: null, managedAllowed: true, sharedIdentifier: expect.any(String) },
    });
    expect(view.checks.map((c) => c.code)).toEqual(
      expect.arrayContaining(['BRAND_LOGO', 'BRAND_ICON', 'SUPPORT_MISSING', 'APPLE_SHARED_ID']),
    );
  });

  it('names the default platform pass type, not the env one, once the default moved', async () => {
    await run(api.rig.db, 'UPDATE signing_identities SET is_default = 0 WHERE is_default = 1');
    await run(
      api.rig.db,
      "INSERT INTO credentials (id, kind, kek_version, iv, wrapped_dek, ciphertext, created_at) VALUES ('ps-cred', 'pass_signer', 1, x'00', x'00', x'00', 1)",
    );
    await run(
      api.rig.db,
      `INSERT INTO signing_identities (id, org_id, label, pass_type_identifier, team_identifier, source,
         credential_id, provenance, purpose, is_default, issuing, created_at)
       VALUES ('ps-root', NULL, 'Root', 'pass.mobile.passbook', 'TEAM123456', 'db', 'ps-cred', 'platform', 'passes', 1, 1, 1)`,
    );
    try {
      expect((await read()).view.apple.sharedIdentifier).toBe('pass.mobile.passbook');
    } finally {
      await run(api.rig.db, "DELETE FROM signing_identities WHERE id = 'ps-root'");
      await run(api.rig.db, "DELETE FROM credentials WHERE id = 'ps-cred'");
      await run(api.rig.db, "UPDATE signing_identities SET is_default = 1 WHERE id = 'platform'");
    }
  });

  it('never carries storage detail of an image', async () => {
    await run(api.rig.db, 'UPDATE orgs SET branding = ? WHERE id = ?', [
      JSON.stringify({
        logo: { sha: 'a'.repeat(64), w: 480, h: 150, storageVersion: 'secretver' },
      }),
      orgId,
    ]);
    const { text, view } = await read();
    expect(view.brand.logo).toEqual({
      value: { sha: 'a'.repeat(64), w: 480, h: 150 },
      source: 'org',
      templatesOwn: 0,
    });
    expect(text).not.toContain('secretver');
    await run(api.rig.db, "UPDATE orgs SET branding = '{}' WHERE id = ?", [orgId]);
  });

  it('PassBook level: a channel the platform has not released or turned off is locked', async () => {
    await setSetting(api, 'platform', 'print.enabled', false);
    await setSetting(api, 'platform', 'nfc.tagsEnabled', false);
    const { view } = await read();
    expect(level(view, 'google', 'passbook')).toMatchObject({
      state: 'locked',
      reason: 'not_released',
      canChange: false,
    });
    expect(level(view, 'paper', 'passbook')).toMatchObject({
      state: 'locked',
      reason: 'printing_off',
    });
    expect(level(view, 'nfc', 'passbook')).toMatchObject({ state: 'locked', reason: 'tags_off' });
    expect(view.channels.paper.on).toBe(false);
    expect(view.channels.mobile.on).toBe(true);
  });

  it('Plan level: a plan without the feature is Plan, not PassBook', async () => {
    const trial = await orgWith(api, 'trial');
    const member = await api.member(['org_admin'], { orgId: trial });
    const { view } = await read(member, trial);
    expect(level(view, 'paper', 'plan')).toMatchObject({
      state: 'locked',
      reason: 'not_included',
      canChange: false,
    });
    expect(level(view, 'paper', 'passbook')?.state).toBe('ok');
    expect(view.apple.managedAllowed).toBe(false);
  });

  it('Organization level: blocked, tags off and an account not set up', async () => {
    restore.push(setWalletProvidersEnabledForTest(true));
    await setSetting(api, `org:${orgId}`, 'channels.blocked', ['mobile']);
    await setSetting(api, `org:${orgId}`, 'nfc.tags', { enabled: false });
    const { view } = await read();
    expect(level(view, 'mobile', 'org')).toMatchObject({
      state: 'off',
      reason: 'blocked',
      canChange: true,
    });
    expect(view.channels.mobile).toMatchObject({ allowed: false, on: false });
    expect(level(view, 'nfc', 'org')).toMatchObject({ state: 'off', reason: 'tags_off' });
    expect(view.channels.nfc.allowed).toBe(false);
    expect(level(view, 'google', 'passbook')?.state).toBe('ok');
    expect(level(view, 'google', 'org')).toMatchObject({ state: 'needs', reason: 'not_enrolled' });
    expect(view.channels.google).toMatchObject({ allowed: true, on: false });
  });

  it('Template level: counts on, off and never over the org’s templates, per mode', async () => {
    await seedTemplate(api, orgId, 'tpl_a');
    await seedTemplate(api, orgId, 'tpl_b', { policy: { apple: 'never', mobile: 'off' } });
    await seedTemplate(api, orgId, 'tpl_c', { manifest: { channels: { paper: 'on' } } });
    const { view } = await read();
    expect(view.channels.apple.templates).toEqual({ on: 2, off: 0, never: 1, total: 3 });
    expect(view.channels.mobile.templates).toEqual({ on: 2, off: 1, never: 0, total: 3 });
    expect(view.channels.paper.templates).toEqual({ on: 1, off: 2, never: 0, total: 3 });
    expect(level(view, 'apple', 'template')).toMatchObject({ state: 'partial' });
    expect(view.templates.map((t) => t.id)).toEqual(['tpl_a', 'tpl_b', 'tpl_c']);
    expect(view.templates[1]?.channels.apple).toMatchObject({ on: false, reason: 'never' });
    // The Test mode has no policy rows: every template follows its defaults.
    const test = await api.key({ scopes: ['org:read'], mode: 'test' });
    const t = (await read(test)).view;
    expect(t.mode).toBe('test');
    expect(t.channels.apple.templates).toEqual({ on: 3, off: 0, never: 0, total: 3 });
  });

  it('a template that keeps the blueprint art lists its placeholder slots', async () => {
    await seedTemplate(api, orgId, 'baked:starter-x');
    const { view } = await read();
    expect(view.templates.find((t) => t.id === 'baked:starter-x')?.placeholders).toEqual([
      'logo',
      'icon',
    ]);
  });
});

describe('who may read', () => {
  it('an org:read key reads its own org; another org is refused', async () => {
    const key = await api.key({ scopes: ['org:read'] });
    expect((await read(key)).status).toBe(200);
    const other = await api.otherOrg();
    expect((await read(key, other)).status).toBe(403);
  });

  it('a brand:manage key reads too, but its Organization level is not its to change', async () => {
    const brand = await api.key({ scopes: ['brand:manage'] });
    const { status, view } = await read(brand);
    expect(status).toBe(200);
    expect(level(view, 'mobile', 'org')?.canChange).toBe(false);
  });

  it('a key without org:read and an outsider are refused', async () => {
    const wrong = await api.key({ scopes: ['passes:read'] });
    expect((await read(wrong)).status).toBe(403);
    expect((await read(await api.outsider())).status).toBe(403);
  });

  it('canChange follows the caller: Organization for an admin, Template for a publisher', async () => {
    const publisher = await api.member(['template_publisher']);
    const { view } = await read(publisher);
    expect(level(view, 'mobile', 'org')?.canChange).toBe(false);
    expect(level(view, 'mobile', 'template')?.canChange).toBe(true);
    expect(level(view, 'mobile', 'passbook')?.canChange).toBe(false);
    const key = await api.key({ scopes: ['org:read', 'org:write'] });
    expect(level((await read(key)).view, 'mobile', 'org')?.canChange).toBe(true);
  });
});
