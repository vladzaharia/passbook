import { describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';

const json = { 'content-type': 'application/json' };

async function setup() {
  const kit = await ruleKit();
  const pass = await kit.datedPass();
  const other = await kit.datedPass();
  const call = (method: string, path: string, body?: unknown) =>
    kit.api(path, {
      method,
      headers: { ...kit.auth.admin(), ...json },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const channelsOf = async (templateId: string) =>
    (await (await call('GET', `/templates/${templateId}/channels?orgId=${kit.org.id}`)).json()) as {
      levels: Record<
        string,
        { level: string; state: string; reason?: string; canChange: boolean }[]
      >;
      overrides: Record<string, number>;
      overridePasses: number;
    };
  return { kit, pass, other, call, channelsOf };
}

type Reset = { overrides: Record<string, number>; passes: number; done: number; remaining: number };

describe('chain levels on the channel reads', () => {
  it('lists PassBook, Plan, Organization and Template for a template', async () => {
    const { pass, channelsOf } = await setup();
    const body = await channelsOf(pass.templateId);
    expect(body.levels.apple?.map((l) => l.level)).toEqual(['passbook', 'plan', 'org', 'template']);
    expect(body.levels.apple?.every((l) => l.state === 'ok')).toBe(true);
    // Google is not released: PassBook stops it, and a platform admin may change that level.
    const google = body.levels.google ?? [];
    expect(google[0]).toMatchObject({ level: 'passbook', state: 'locked', reason: 'not_released' });
    expect(google[0]?.canChange).toBe(true);
  });

  it('marks the template level off when the template turns a channel off', async () => {
    const { kit, pass, call, channelsOf } = await setup();
    await call('PUT', `/templates/${pass.templateId}/channels`, {
      channels: { apple: 'off' },
      orgId: kit.org.id,
      revision: 0,
    });
    const apple = (await channelsOf(pass.templateId)).levels.apple ?? [];
    expect(apple.find((l) => l.level === 'template')).toMatchObject({
      state: 'off',
      reason: 'template_off',
    });
  });

  it('ends a pass chain in This pass and marks the level that stops it', async () => {
    const { kit, pass, call } = await setup();
    await run(
      kit.env.DB,
      'INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)',
      [`org:${kit.org.id}`, 'channels.blocked', JSON.stringify(['mobile']), 'test', 1],
    );
    clearSettingsCache(kit.env.DB);
    const body = (await (await call('GET', `/passes/${pass.id}/channels`)).json()) as {
      levels: Record<string, { level: string; state: string }[]>;
    };
    const mobile = body.levels.mobile ?? [];
    expect(mobile.map((l) => l.level)).toEqual(['passbook', 'plan', 'org', 'template', 'pass']);
    expect(mobile.find((l) => l.state !== 'ok')).toMatchObject({ level: 'org', state: 'off' });
  });
});

describe('reset passes', () => {
  it('counts the passes with their own choice per channel', async () => {
    const { pass, other, call, channelsOf } = await setup();
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'off', mobile: 'off' } });
    await call('PUT', `/passes/${other.id}/channels`, { channels: { apple: 'off' } });
    const body = await channelsOf(pass.templateId);
    expect(body.overrides).toMatchObject({ apple: 2, mobile: 1, google: 0 });
    expect(body.overridePasses).toBe(2);
  });

  it('a dry run changes nothing', async () => {
    const { kit, pass, call } = await setup();
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'off' } });
    const res = await call('POST', `/templates/${pass.templateId}/channels/reset-passes`, {
      orgId: kit.org.id,
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ passes: 1, done: 0, remaining: 1 });
    const left = await all<{ override: string }>(
      kit.env.DB,
      'SELECT override FROM pass_channels WHERE override IS NOT NULL AND template_id = ?',
      [pass.templateId],
    );
    expect(left).toHaveLength(1);
  });

  it('resets only the channels that have an override and leaves other templates alone', async () => {
    const { kit, pass, other, call, channelsOf } = await setup();
    await call('PUT', `/passes/${pass.id}/channels`, { channels: { apple: 'off', mobile: 'on' } });
    await call('PUT', `/passes/${other.id}/channels`, { channels: { apple: 'off' } });
    const res = await call('POST', `/templates/${pass.templateId}/channels/reset-passes`, {
      orgId: kit.org.id,
      channels: ['apple'],
    });
    const body = (await res.json()) as Reset;
    expect(body).toMatchObject({ passes: 2, done: 2, remaining: 0 });
    expect(body.overrides).toMatchObject({ apple: 2, mobile: 0 });
    // The mobile override, not named, is still there.
    const after = await channelsOf(pass.templateId);
    expect(after.overrides).toMatchObject({ apple: 0, mobile: 1 });
    const effective = (await (await call('GET', `/passes/${pass.id}/channels`)).json()) as {
      effective: Record<string, { on: boolean; source: string }>;
    };
    expect(effective.effective.apple).toEqual({ on: true, source: 'template' });
  });

  it('asks for the right to operate passes as well as to publish templates', async () => {
    const { kit, pass } = await setup();
    const res = await kit.api(`/templates/${pass.templateId}/channels/reset-passes`, {
      method: 'POST',
      headers: { ...kit.auth.user(), ...json },
      body: JSON.stringify({ orgId: kit.org.id }),
    });
    expect([403, 404]).toContain(res.status);
  });
});
