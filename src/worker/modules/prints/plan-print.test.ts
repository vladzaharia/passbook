import { describe, expect, it } from 'vitest';
import { linkToken } from '../../../../test/helpers/index.ts';
import { all, run } from '../../platform/db.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { linkWriter, writeMint } from './repo-write.ts';

const json = { 'content-type': 'application/json' };
const ORIGIN = 'https://wallet.test';
type Minted = { id: string; status: string; code: string };

async function setup() {
  const kit = await ruleKit();
  await run(
    kit.env.DB,
    "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
  );
  clearSettingsCache(kit.env.DB);
  const api = (method: string, path: string, body?: unknown) =>
    kit.api(path, {
      method,
      headers: { ...kit.auth.admin(), ...json },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const pass = await kit.datedPass({}, 'holder@example.com');
  expect(
    (await api('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } })).status,
  ).toBe(200);
  const print = (value: 0 | 1) =>
    run(
      kit.env.DB,
      `INSERT OR REPLACE INTO org_entitlement_overrides (org_id, key, value, updated_at)
       VALUES (?, 'print', ?, 1)`,
      [kit.org.id, JSON.stringify(value)],
    );
  const prints = () =>
    all<{ id: string; status: string }>(
      kit.env.DB,
      'SELECT id, status FROM pass_prints WHERE pass_id = ?',
      [pass.id],
    );
  return { kit, api, pass, print, prints };
}

describe('the print feature', () => {
  it('a legacy org prints as before', async () => {
    const { api, pass } = await setup();
    const res = await api('POST', `/passes/${pass.id}/prints`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as Minted).status).toBe('active');
  });

  it('refuses a new print with FEATURE_NOT_INCLUDED and names paper as not included', async () => {
    const { api, pass, print, prints } = await setup();
    await print(0);
    const res = await api('POST', `/passes/${pass.id}/prints`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'FEATURE_NOT_INCLUDED', feature: 'print' });
    expect(await prints()).toHaveLength(0);
    const channels = (await (await api('GET', `/passes/${pass.id}/channels`)).json()) as {
      effective: { paper: unknown };
    };
    expect(channels.effective.paper).toEqual({
      on: false,
      source: 'platform',
      reason: 'not_included',
    });
  });

  it('a holder link is refused the same way', async () => {
    const { kit, pass, print } = await setup();
    await print(0);
    const token = await linkToken(kit.env, pass as never);
    const res = await kit.app.request(
      `${ORIGIN}/p/${token}/print`,
      { method: 'POST', headers: { origin: ORIGIN } },
      kit.env,
    );
    expect(res.status).toBe(403);
  });

  it('the holder gets the ticket they have back after a downgrade, and holder copy when there is none (L6)', async () => {
    const { kit, api, pass, print } = await setup();
    const token = await linkToken(kit.env, pass as never);
    const holder = () =>
      kit.app.request(
        `${ORIGIN}/p/${token}/print`,
        { method: 'POST', headers: { origin: ORIGIN } },
        kit.env,
      );
    await print(0);
    const refused = await holder();
    expect(refused.status).toBe(403);
    const body = await refused.json();
    expect(body).toMatchObject({ code: 'FEATURE_NOT_INCLUDED', feature: 'print' });
    expect(JSON.stringify(body)).not.toContain('PassBook');
    await print(1);
    const minted = (await (await api('POST', `/passes/${pass.id}/prints`)).json()) as Minted;
    await print(0);
    const again = await holder();
    expect(again.status).toBe(200);
    expect(((await again.json()) as Minted).id).toBe(minted.id);
  });

  it('a downgrade pauses: the ticket stays, can be listed and voided, and a mint returns on upgrade', async () => {
    const { api, pass, print, prints } = await setup();
    const minted = (await (await api('POST', `/passes/${pass.id}/prints`)).json()) as Minted;
    await print(0);
    const list = (await (await api('GET', `/passes/${pass.id}/prints`)).json()) as {
      prints: { id: string; status: string }[];
    };
    expect(list.prints).toEqual([expect.objectContaining({ id: minted.id, status: 'active' })]);
    expect((await api('POST', `/passes/${pass.id}/prints/${minted.id}/void`)).status).toBe(200);
    expect((await api('POST', `/passes/${pass.id}/prints`)).status).toBe(403);
    await print(1);
    expect((await api('POST', `/passes/${pass.id}/prints`)).status).toBe(200);
    expect((await prints()).map((p) => p.status).sort()).toEqual(['active', 'voided']);
  });

  it('the grant is the backstop: a mint past the service check still refuses', async () => {
    const { kit, pass, print, prints } = await setup();
    const mint = () =>
      writeMint(
        kit.ctx,
        linkWriter(pass),
        pass.id,
        {
          id: kit.ctx.ids.id(),
          codeHash: 'a'.repeat(64),
          rosterHash: 'b'.repeat(32),
          generation: 1,
          passVersion: 1,
          paperHash: null,
        },
        false,
      );
    await print(0);
    await expect(mint()).rejects.toMatchObject({ status: 403, code: 'FEATURE_NOT_INCLUDED' });
    expect(await prints()).toHaveLength(0);
    await print(1);
    await mint();
    expect(await prints()).toHaveLength(1);
  });
});
