import { describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';

const json = { 'content-type': 'application/json' };
type Listed = {
  prints: { id: string; status: string; passVersion: number | null; stale: boolean }[];
};
const HASH = /^[0-9a-f]{64}$/;

async function setup() {
  const kit = await ruleKit();
  await run(
    kit.env.DB,
    "INSERT OR REPLACE INTO settings (scope, key, value, updated_by, updated_at) VALUES ('platform', 'print.enabled', 'true', 'test', 1)",
  );
  clearSettingsCache(kit.env.DB);
  const api = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    kit.api(path, {
      method,
      headers: { ...kit.auth.admin(), ...json, ...headers },
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
  const row = async () =>
    (
      await all<{ pass_version: number; paper_hash: string }>(
        kit.env.DB,
        'SELECT pass_version, paper_hash FROM pass_prints WHERE pass_id = ? AND status = ?',
        [pass.id, 'active'],
      )
    )[0];
  /** A real edit of a shown field: the holder's name. */
  const rename = async (name: string) => {
    const current = (await (await api('GET', `/passes/${pass.id}`)).json()) as {
      version: number;
    };
    const res = await api(
      'PATCH',
      `/passes/${pass.id}`,
      { input: { memberName: name } },
      { 'if-match': `"${current.version}"` },
    );
    expect(res.status).toBe(200);
  };
  return { kit, api, pass, list, page, setPass, row, rename };
}

describe('prints: stale printouts', () => {
  it('stores the pass version and the drawing hash at mint', async () => {
    const { api, pass, list, row } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    const r = await row();
    expect(r?.pass_version).toBe(pass.version);
    expect(r?.paper_hash).toMatch(HASH);
    expect(await list()).toMatchObject([{ passVersion: pass.version, stale: false }]);
  });

  it('a real broadcast publish leaves the print current', async () => {
    const { kit, api, pass, list, row } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    const before = await row();
    const sent = await kit.send('POST', '/message-rules', kit.ruleBody());
    expect(sent.status).toBe(201);
    await run(kit.env.DB, 'UPDATE passes SET personalization = ? WHERE id = ?', [
      JSON.stringify({ memberName: 'Alex', message: 'Hello' }),
      pass.id,
    ]);
    const res = await api(
      'PATCH',
      `/passes/${pass.id}`,
      { input: { message: 'Hello again' } },
      {
        'if-match': `"${pass.version}"`,
      },
    );
    expect(res.status).toBe(200);
    expect((await list())[0]?.stale).toBe(false);
    expect((await row())?.paper_hash).toBe(before?.paper_hash);
  });

  it('a paper-visible change makes it stale; drawing the PDF again clears it', async () => {
    const { api, pass, list, page, rename, row } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    const before = await row();
    await rename('Renamed Holder');
    expect(await list()).toMatchObject([{ passVersion: pass.version, stale: true }]);
    expect(await page()).toContain('Printed before the last change.');
    const pdf = await api('GET', `/passes/${pass.id}/print/pdf`);
    expect(pdf.status).toBe(200);
    await pdf.arrayBuffer();
    expect((await list())[0]?.stale).toBe(false);
    const after = await row();
    expect(after?.paper_hash).not.toBe(before?.paper_hash);
    expect(after?.pass_version).toBeGreaterThan(before?.pass_version ?? 0);
  });

  it('the staff drawn call refreshes, and a reprint is current', async () => {
    const { api, pass, list, rename } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    await rename('Another Name');
    expect((await list())[0]?.stale).toBe(true);
    expect((await api('POST', `/passes/${pass.id}/print/drawn`)).status).toBe(200);
    expect((await list())[0]?.stale).toBe(false);
    await rename('Third Name');
    await api('POST', `/passes/${pass.id}/prints`);
    expect(await list()).toMatchObject([
      { status: 'active', stale: false },
      { status: 'voided', stale: false },
    ]);
  });

  it('lists without failing when the ticket cannot be drawn, and says not stale', async () => {
    const { kit, api, pass, list } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    await run(kit.env.DB, 'DELETE FROM pass_versions WHERE pass_id = ?', [pass.id]);
    const res = await api('GET', `/passes/${pass.id}/prints`);
    expect(res.status).toBe(200);
    expect(await list()).toMatchObject([{ status: 'active', stale: false }]);
  });

  it('a print without a recorded drawing is never stale', async () => {
    const { kit, api, pass, list, rename } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    await run(
      kit.env.DB,
      'UPDATE pass_prints SET paper_hash = NULL, pass_version = NULL WHERE pass_id = ?',
      [pass.id],
    );
    await rename('Quiet Name');
    expect(await list()).toMatchObject([{ passVersion: null, stale: false }]);
  });

  it.each([
    ['pass_voided', true],
    ['transfer', true],
    ['new_code', true],
    ['holder_change', false],
    ['manual', false],
  ])('after a %s void the empty page says print again: %s', async (cause, again) => {
    const { kit, api, pass, page } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    await run(
      kit.env.DB,
      "UPDATE pass_prints SET status = 'voided', voided_at = 1, void_cause = ? WHERE pass_id = ?",
      [cause, pass.id],
    );
    const html = await page();
    expect(html.includes('The earlier print ended.')).toBe(again);
  });

  it('asks to print again once a voided pass is restored', async () => {
    const { api, pass, list, page, setPass } = await setup();
    await api('POST', `/passes/${pass.id}/prints`);
    await setPass("status = 'voided'");
    await setPass("status = 'active'");
    expect(await list()).toMatchObject([{ status: 'voided', stale: false }]);
    const html = await page();
    expect(html).toContain('The earlier print ended.');
    expect(html).not.toContain('data-stale');
  });
});
