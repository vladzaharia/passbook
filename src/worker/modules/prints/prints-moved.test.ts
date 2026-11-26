import { describe, expect, it } from 'vitest';
import { linkToken } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { ruleKit } from '../message-rules/test-kit.ts';
import { clearSettingsCache } from '../settings/service.ts';

const json = { 'content-type': 'application/json' };
type Minted = { id: string; code: string };

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
  const withPaper = async (email: string) => {
    const pass = await kit.datedPass({}, email);
    expect(
      (await api('PUT', `/passes/${pass.id}/channels`, { channels: { paper: 'on' } })).status,
    ).toBe(200);
    return pass;
  };
  /** The row an identity move writes for `old` and `next`. */
  const linked = (old: { id: string; orgId: string }, next: { id: string }) =>
    run(
      kit.env.DB,
      `INSERT INTO pass_moves (id, op_id, org_id, mode, from_identity_id, to_identity_id, old_pass_id, new_pass_id,
         state, created_at, updated_at) VALUES (?, 'op', ?, 'live', 'a', 'b', ?, ?, 'registered', 1, 1)`,
      [kit.fx.ids.id(), old.orgId, old.id, next.id],
    );
  return { kit, api, withPaper, linked };
}

describe('a printed card after an identity move', () => {
  it('keeps its code: the print follows the replacement and shows the same code', async () => {
    const { kit, api, withPaper, linked } = await setup();
    const old = await withPaper('old@example.com');
    const next = await withPaper('old@example.com');
    const printed = (await (await api('POST', `/passes/${old.id}/prints`)).json()) as Minted;
    await linked(old, next);
    await run(kit.env.DB, 'UPDATE pass_prints SET pass_id = ?, code_pass_id = ? WHERE id = ?', [
      next.id,
      old.id,
      printed.id,
    ]);
    // The holder opens the print again: it is drawn from the pass it follows, with the code on paper.
    const token = await linkToken(kit.env, next as never);
    const again = (await (
      await kit.app.request(
        `https://wallet.test/p/${token}/print`,
        { method: 'POST', headers: { origin: 'https://wallet.test' } },
        kit.env,
      )
    ).json()) as Minted;
    expect(again.id).toBe(printed.id);
    expect(again.code).toBe(printed.code);
  });

  it('refuses to move a print to a pass that is not the replacement of a move', async () => {
    const { kit, api, withPaper } = await setup();
    const old = await withPaper('a@example.com');
    const other = await withPaper('b@example.com');
    const printed = (await (await api('POST', `/passes/${old.id}/prints`)).json()) as Minted;
    await expect(
      run(kit.env.DB, 'UPDATE pass_prints SET pass_id = ?, code_pass_id = ? WHERE id = ?', [
        other.id,
        old.id,
        printed.id,
      ]),
    ).rejects.toThrow(/pass_print_key/);
    expect(
      await first(kit.env.DB, 'SELECT pass_id FROM pass_prints WHERE id = ?', [printed.id]),
    ).toEqual({ pass_id: old.id });
    expect(
      await all(kit.env.DB, 'SELECT 1 FROM pass_prints WHERE pass_id = ?', [other.id]),
    ).toHaveLength(0);
  });
});
