import { describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';

const json = { 'content-type': 'application/json' };
type Listed = {
  prints: { id: string; status: string; passVersion: number | null; stale: boolean }[];
};

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
  const list = async () =>
    ((await (await api('GET', `/passes/${pass.id}/prints`)).json()) as Listed).prints;
  const page = async () =>
    (await kit.api(`/passes/${pass.id}/print`, { headers: kit.auth.admin() })).text();
  const setPass = (sql: string) =>
    run(kit.env.DB, `UPDATE passes SET ${sql} WHERE id = ?`, [pass.id]);
  return { kit, api, pass, list, page, setPass };
}

describe('prints: stale printouts', () => {
  it('stores the pass version a print was made from', async () => {
    const { kit, api, pass, list } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    const rows = await all<{ pass_version: number }>(
      kit.env.DB,
      'SELECT pass_version FROM pass_prints WHERE pass_id = ?',
      [pass.id],
    );
    expect(rows).toEqual([{ pass_version: pass.version }]);
    expect(await list()).toMatchObject([{ passVersion: pass.version, stale: false }]);
  });

  it('is stale after a content change, and a reprint clears it', async () => {
    const { api, pass, list, page, setPass } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    expect(await page()).not.toContain('data-stale');
    await setPass('version = version + 1');
    expect(await list()).toMatchObject([{ passVersion: pass.version, stale: true }]);
    expect(await page()).toContain('Printed before the last change.');
    await api('POST', `/passes/${pass.id}/prints`);
    expect(await list()).toMatchObject([
      { passVersion: pass.version + 1, stale: false },
      { status: 'voided', stale: false },
    ]);
  });

  it('a print without a recorded version is never stale', async () => {
    const { kit, api, pass, list, setPass } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    await run(kit.env.DB, 'UPDATE pass_prints SET pass_version = NULL WHERE pass_id = ?', [
      pass.id,
    ]);
    await setPass('version = version + 1');
    expect(await list()).toMatchObject([{ passVersion: null, stale: false }]);
  });

  it('asks to print again once a voided pass is restored', async () => {
    const { api, pass, list, page, setPass } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    await setPass("status = 'voided'");
    await setPass("status = 'active'");
    expect(await list()).toMatchObject([{ status: 'voided', stale: false }]);
    const html = await page();
    expect(html).toContain('The earlier print ended. Print again.');
    expect(html).not.toContain('data-stale');
  });
});
