import { describe, expect, it } from 'vitest';
import { run } from '../../platform/db.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';

const json = { 'content-type': 'application/json' };
type Eff = Record<string, { on: boolean; source: string; reason?: string }>;

async function setup(declared: Record<string, string> | null) {
  const kit = await ruleKit();
  const pass = await kit.datedPass();
  if (declared) {
    // Test-only: versions are immutable, so lift the guard to declare the manifest block.
    await run(kit.env.DB, 'DROP TRIGGER IF EXISTS template_versions_immutable');
    await run(
      kit.env.DB,
      "UPDATE template_versions SET manifest = json_set(manifest, '$.channels', json(?)) WHERE template_id = ?",
      [JSON.stringify(declared), pass.templateId],
    );
  }
  const call = (method: string, path: string, body?: unknown) =>
    kit.api(path, {
      method,
      headers: { ...kit.auth.admin(), ...json },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const setting = async (scope: string, key: string, value: unknown) => {
    await run(
      kit.env.DB,
      'INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
      [scope, key, JSON.stringify(value), 'test', 1],
    );
    clearSettingsCache(kit.env.DB);
  };
  const passEff = async () =>
    ((await (await call('GET', `/passes/${pass.id}/channels`)).json()) as { effective: Eff })
      .effective;
  const template = async () =>
    (await (
      await call('GET', `/templates/${pass.templateId}/channels?orgId=${kit.org.id}`)
    ).json()) as { effective: Eff; revision: number; defaults: Record<string, string> };
  return { kit, pass, call, setting, passEff, template };
}

describe('manifest channel defaults', () => {
  it('a door template has paper and tags on', async () => {
    const { passEff, template } = await setup({ paper: 'on', nfc: 'on' });
    const e = await passEff();
    expect(e.paper).toEqual({ on: true, source: 'template' });
    expect(e.nfc).toEqual({ on: true, source: 'template' });
    expect(e.mobile?.on).toBe(true);
    expect(e.apple?.on).toBe(true);
    expect((await template()).defaults).toMatchObject({ paper: 'on', nfc: 'on', mobile: 'on' });
  });

  it('a membership template has paper off and tags on', async () => {
    const { passEff, template } = await setup({ paper: 'off', nfc: 'on' });
    const e = await passEff();
    expect(e.paper).toEqual({ on: false, source: 'template', reason: 'template_off' });
    expect(e.nfc?.on).toBe(true);
    expect((await template()).defaults.paper).toBe('off');
  });

  it('a loyalty template has paper and tags off', async () => {
    const { passEff } = await setup({ paper: 'off', nfc: 'off' });
    const e = await passEff();
    expect(e.paper).toMatchObject({ on: false, reason: 'template_off' });
    expect(e.nfc).toMatchObject({ on: false, source: 'template', reason: 'template_off' });
  });

  it('a template without the block keeps the global defaults', async () => {
    const { passEff } = await setup(null);
    const e = await passEff();
    expect(e.paper).toMatchObject({ on: false, reason: 'template_off' });
    expect(e.nfc?.on).toBe(true);
  });

  it('a template policy row overrides the manifest default', async () => {
    const door = await setup({ paper: 'on', nfc: 'on' });
    const view = await door.template();
    const res = await door.call('PUT', `/templates/${door.pass.templateId}/channels`, {
      orgId: door.kit.org.id,
      revision: view.revision,
      channels: { paper: 'off' },
    });
    expect(res.status).toBe(200);
    expect((await door.passEff()).paper).toMatchObject({ on: false, reason: 'template_off' });
    const loyalty = await setup({ paper: 'off', nfc: 'off' });
    const v2 = await loyalty.template();
    await loyalty.call('PUT', `/templates/${loyalty.pass.templateId}/channels`, {
      orgId: loyalty.kit.org.id,
      revision: v2.revision,
      channels: { paper: 'on' },
    });
    expect((await loyalty.passEff()).paper).toEqual({ on: true, source: 'template' });
  });

  it('a pass override still wins', async () => {
    const { pass, call, passEff } = await setup({ paper: 'off', nfc: 'off' });
    const res = await call('PUT', `/passes/${pass.id}/channels`, { channels: { nfc: 'on' } });
    expect(res.status).toBe(200);
    expect((await passEff()).nfc).toEqual({ on: true, source: 'pass' });
  });

  it('the platform can still turn paper off', async () => {
    const { setting, passEff } = await setup({ paper: 'on', nfc: 'on' });
    await setting('platform', 'print.enabled', false);
    expect((await passEff()).paper).toEqual({
      on: false,
      source: 'platform',
      reason: 'printing_off',
    });
  });
});

describe('linked tags', () => {
  it('work with Apple NFC off', async () => {
    const { setting, passEff } = await setup({ nfc: 'on' });
    await setting('platform', 'nfc.enabled', false);
    expect((await passEff()).nfc).toEqual({ on: true, source: 'template' });
  });

  it('the org can turn them off', async () => {
    const { kit, setting, passEff } = await setup({ nfc: 'on' });
    await setting(`org:${kit.org.id}`, 'nfc.tags', { enabled: false });
    expect((await passEff()).nfc).toEqual({ on: false, source: 'org', reason: 'tags_off' });
  });

  it('the platform can turn them off without touching Apple NFC', async () => {
    const { setting, passEff } = await setup({ nfc: 'on' });
    await setting('platform', 'nfc.tagsEnabled', false);
    expect((await passEff()).nfc).toEqual({ on: false, source: 'platform', reason: 'tags_off' });
  });
});
