import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { publishPass } from '../passes/publish.ts';
import { releaseStamps, stampCard, stampVersion } from '../passes/stamps-test-fixtures.ts';
import { act, kit, out, rows, setupActionFixture } from './act-test-fixtures.ts';
import { showBalance } from './act-value-test-fixtures.ts';
import { codeOf, key, startScanCredentialTransfer } from './test-kit.ts';

beforeAll(setupActionFixture);

const ADD = { id: 'add', label: 'Add', kind: 'add', input: 'balance', repeat: 'always' } as const;
const desk = (templateIds: string[], settings: Record<string, unknown> = {}) =>
  kit.scanner({ templateIds, settings: { roleWithoutSignIn: 'desk', ...settings } });
const passRow = async (id: string) => {
  const row = await first<{ personalization: string; status: string; version: number }>(
    kit.env.DB,
    'SELECT personalization, status, version FROM passes WHERE id = ?',
    [id],
  );
  const input = JSON.parse(row?.personalization ?? '{}') as { balance?: number; tier?: string };
  return { ...input, status: row?.status, version: row?.version ?? 0 };
};
const undo = (headers: Record<string, string>, scanId: string | null) =>
  kit.post(headers, `/scans/${scanId}/undo`, { idempotencyKey: key() });
/** Something else republishes the pass: its version moves, whatever it holds. */
const touch = (passId: string) =>
  publishPass(jobCtxOf(kit), {
    passId,
    actor: { type: 'system', id: null },
    cause: 'admin',
    force: true,
  });

describe('undo of a void or a set that something else touched since', () => {
  it('refuses to unvoid a pass that was changed after the scan', async () => {
    const t = await kit.scanTemplate('Void then touch', {
      actions: [{ id: 'use', label: 'Use', kind: 'use_up' }],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t);
    const used = await out(await act(s.headers, codeOf(pass), { actionId: 'use' }));
    await touch(pass.id);
    const res = await undo(s.headers, used.scanId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('UNDO_SUPERSEDED');
    expect((await passRow(pass.id)).status).toBe('voided');
  });

  it('refuses to put a set back after the pass was touched', async () => {
    const t = await kit.scanTemplate('Set then touch', {
      actions: [{ id: 'tier', label: 'Tier', kind: 'set', input: 'tier', minRole: 'desk' }],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { tier: 'Silver' });
    const set = await out(await act(s.headers, codeOf(pass), { actionId: 'tier', value: 'Gold' }));
    await touch(pass.id);
    const res = await undo(s.headers, set.scanId);
    expect(res.status).toBe(409);
    expect((await passRow(pass.id)).tier).toBe('Gold');
  });

  it('answers a pass with a transfer under way as a scan that is not there', async () => {
    const t = await kit.scanTemplate('Undo transfer', { actions: [{ ...ADD, amount: 1 }] });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 0 });
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    await startScanCredentialTransfer(kit, pass.id);
    const res = await undo(s.headers, o.scanId);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('SCAN_NOT_FOUND');
  });

  it('refuses to undo a connection-owned field', async () => {
    const t = await kit.scanTemplate('Undo connected', { actions: [{ ...ADD, amount: 1 }] });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 0 });
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    await run(
      kit.env.DB,
      'UPDATE passes SET field_sources = \'{"balance":"connection"}\' WHERE id = ?',
      [pass.id],
    );
    expect((await undo(s.headers, o.scanId)).status).toBe(409);
    expect((await passRow(pass.id)).balance).toBe(1);
  });

  it('puts a take back within the schema maximum', async () => {
    const t = await kit.scanTemplate('Undo clamp', {
      actions: [
        { id: 'take', label: 'Take', kind: 'take', input: 'balance', amount: 5, repeat: 'always' },
      ],
    });
    await showBalance(t, { maximum: 10 });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 8 });
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'take' }));
    await run(
      kit.env.DB,
      "UPDATE passes SET personalization = json_set(personalization, '$.balance', 9) WHERE id = ?",
      [pass.id],
    );
    const res = await undo(s.headers, o.scanId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await passRow(pass.id)).balance).toBe(10);
  });
});

describe('value gates on a check-in-configured scanner', () => {
  it('keeps the cooldown of an add: two at once apply once', async () => {
    const t = await kit.scanTemplate('Cooldown on a daily scanner', {
      actions: [{ ...ADD, amount: 1, repeat: 'cooldown', cooldownMinutes: 10 }],
    });
    await showBalance(t);
    const s = await desk([t], { checkIn: { mode: 'daily' } });
    const pass = await kit.scanPass(t, { balance: 0 });
    const results = await Promise.all(
      [0, 1].map(() => act(s.headers, codeOf(pass), { actionId: 'add' })),
    );
    const kinds = await Promise.all(
      results.map(async (res) =>
        res.status === 200 ? ((await out(res)).reason ?? 'ok') : 'error',
      ),
    );
    expect(kinds.filter((k) => k === 'ok')).toHaveLength(1);
    expect((await passRow(pass.id)).balance).toBe(1);
  });
});

describe('an add never lowers a value', () => {
  it('leaves a balance above a waiting release maximum as it is, and records nothing applied', async () => {
    const t = await kit.scanTemplate('Add above the cap', { actions: [{ ...ADD, amount: 1 }] });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 50 });
    await showBalance(t, { maximum: 30 });
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    expect(o).toMatchObject({ kind: 'ok', value: { before: 50, after: 50 } });
    expect((await passRow(pass.id)).balance).toBe(50);
    const [scan] = await rows<{ amount: number | null }>('SELECT amount FROM scans WHERE id = ?', [
      o.scanId ?? '',
    ]);
    expect(scan?.amount).toBe(0);
  });

  it('records what a capped add applied', async () => {
    const t = await kit.scanTemplate('Capped amount', { actions: [{ ...ADD, amount: 5 }] });
    await showBalance(t, { maximum: 12 });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 10 });
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    const [scan] = await rows<{ amount: number | null }>('SELECT amount FROM scans WHERE id = ?', [
      o.scanId ?? '',
    ]);
    expect(scan?.amount).toBe(2);
  });
});

describe('the push budget exemption of a fill', () => {
  it('goes to the first fill of a reward cycle only', async () => {
    const id = `stamps-fill-${kit.fx.ids.token(3)}`;
    await stampVersion(kit, id, 'v1', 10);
    const release = await releaseStamps(kit, id, 'v1');
    const pass = await stampCard(kit, release, 9);
    const s = await desk([id]);
    const alerts = async () =>
      (
        await rows<{ n: number }>(
          "SELECT COUNT(*) AS n FROM pass_events WHERE pass_id = ? AND kind = 'pass.updated' AND json_extract(data, '$.notified') = 1",
          [pass.id],
        )
      )[0]?.n ?? 0;
    const stamp = () =>
      act(s.headers, { code: pass.scanCode ?? '', method: 'camera' }, { actionId: 'stamp' });
    const fill = await out(await stamp());
    expect(fill.milestone).toBe('reward');
    expect(await alerts()).toBe(1);
    expect((await out(await undo(s.headers, fill.scanId).then((r) => r))).kind).toBe('ok');
    // spend the rest of the day's budget, then fill the same card again
    for (let i = 0; i < 2; i++)
      await run(
        kit.env.DB,
        `INSERT INTO pass_events (id, org_id, pass_id, mode, kind, data, at)
         VALUES (?, ?, ?, 'live', 'pass.updated', '{"notified":1}', ?)`,
        [kit.fx.ids.id(), kit.org.id, pass.id, kit.clock.now()],
      );
    expect(await alerts()).toBe(3);
    kit.clock.advance(6 * 60_000);
    expect((await out(await stamp())).kind).toBe('ok');
    // the budget (3 a day) was spent: the second fill goes out silent
    expect(await alerts()).toBe(3);
  });
});

describe('a request that names the card version', () => {
  it('is a different request from one that names another version', async () => {
    const t = await kit.scanTemplate('Version in the hash', {
      actions: [{ id: 'tier', label: 'Tier', kind: 'set', input: 'tier', minRole: 'desk' }],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { tier: 'Silver' });
    const idempotencyKey = key();
    const body = { actionId: 'tier', value: 'Gold', idempotencyKey };
    await act(s.headers, codeOf(pass), { ...body, expectedVersion: pass.version });
    const again = await act(s.headers, codeOf(pass), {
      ...body,
      expectedVersion: pass.version + 5,
    });
    expect(again.status).toBe(422);
    expect(((await again.json()) as { code: string }).code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});
