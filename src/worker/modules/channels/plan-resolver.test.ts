import { describe, expect, it } from 'vitest';
import { effectiveChannels } from '../../../shared/channels.ts';
import { CHANNELS } from '../../../shared/contracts/channels.ts';
import { run } from '../../platform/db.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { loadPass } from './service.ts';

const json = { 'content-type': 'application/json' };
type Status = { on: boolean; source: string; reason?: string };

async function setup() {
  const kit = await ruleKit();
  await run(
    kit.env.DB,
    "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
  );
  clearSettingsCache(kit.env.DB);
  const pass = await kit.datedPass();
  // Paper on for the pass, so the plan is the only thing that can turn it off.
  const put = await kit.api(`/passes/${pass.id}/channels`, {
    method: 'PUT',
    headers: { ...kit.auth.admin(), ...json },
    body: JSON.stringify({ channels: { paper: 'on' } }),
  });
  expect(put.status).toBe(200);
  const effective = async () =>
    (
      (await (
        await kit.api(`/passes/${pass.id}/channels`, { headers: kit.auth.admin() })
      ).json()) as {
        effective: Record<string, Status>;
      }
    ).effective;
  const preset = (value: string) =>
    run(kit.env.DB, 'UPDATE org_entitlements SET preset = ? WHERE org_id = ?', [value, kit.org.id]);
  const override = (key: string, value: unknown) =>
    run(
      kit.env.DB,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
       VALUES (?, ?, ?, 1)`,
      [kit.org.id, key, JSON.stringify(value)],
    );
  return { kit, pass, effective, preset, override };
}

describe('the channel resolver and the plan', () => {
  it('legacy changes nothing: the plan blocks no channel and the resolver reads as it did', async () => {
    const { kit, pass, effective } = await setup();
    const e = await effective();
    expect(e.mobile).toEqual({ on: true, source: 'template' });
    expect(e.apple).toEqual({ on: true, source: 'template' });
    expect(e.google).toEqual({ on: false, source: 'platform', reason: 'not_released' });
    expect(e.samsung).toEqual({ on: false, source: 'platform', reason: 'not_released' });
    expect(e.paper).toEqual({ on: true, source: 'pass' });
    expect(e.nfc).toEqual({ on: true, source: 'template' });
    const { inputs } = await loadPass(kit.ctx, pass);
    expect(inputs.entitlement).toEqual({});
    expect(effectiveChannels(inputs)).toEqual(
      effectiveChannels({ ...inputs, entitlement: undefined }),
    );
    for (const c of CHANNELS) expect(e[c]?.reason).not.toBe('not_included');
  });

  it('trial turns paper and nfc off with not_included, below the platform release for the wallets', async () => {
    const { effective, preset } = await setup();
    await preset('trial');
    const e = await effective();
    expect(e.paper).toEqual({ on: false, source: 'platform', reason: 'not_included' });
    expect(e.nfc).toEqual({ on: false, source: 'platform', reason: 'not_included' });
    expect(e.google).toEqual({ on: false, source: 'platform', reason: 'not_released' });
    expect(e.mobile?.on).toBe(true);
    expect(e.apple?.on).toBe(true);
  });

  it.each([
    ['print', 0, 'paper', false],
    ['print', 1, 'paper', true],
    ['nfc', 'off', 'nfc', false],
    ['nfc', 'basic', 'nfc', true],
    ['nfc', 'secure', 'nfc', true],
  ] as const)('on trial, %s=%s sets %s on=%s', async (key, value, channel, on) => {
    const { effective, preset, override } = await setup();
    await preset('trial');
    await override(key, value);
    const status = (await effective())[channel] as Status;
    expect(status.on).toBe(on);
    if (!on) expect(status.reason).toBe('not_included');
  });

  it('an upgrade restores what the pass and template chose, nothing more', async () => {
    const { effective, preset } = await setup();
    await preset('trial');
    expect((await effective()).paper?.on).toBe(false);
    await preset('standard');
    const e = await effective();
    expect(e.paper).toEqual({ on: true, source: 'pass' });
    expect(e.nfc).toEqual({ on: true, source: 'template' });
  });

  it('the plan outranks an org block and a pass override, and the org block shows once the plan includes it', async () => {
    const { kit, effective, preset } = await setup();
    await run(
      kit.env.DB,
      "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES (?, 'channels.blocked', '[\"paper\"]', 'test', 1)",
      [`org:${kit.org.id}`],
    );
    clearSettingsCache(kit.env.DB);
    await preset('trial');
    expect((await effective()).paper).toEqual({
      on: false,
      source: 'platform',
      reason: 'not_included',
    });
    await preset('standard');
    expect((await effective()).paper).toEqual({ on: false, source: 'org', reason: 'blocked' });
  });
});
