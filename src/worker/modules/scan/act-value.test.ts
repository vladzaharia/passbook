import { beforeAll, describe, expect, it } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { applyConnectionRecord } from '../passes/connection-passes.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { getPass } from '../passes/repo-read-pass.ts';
import { act, kit, out, rows, setupActionFixture } from './act-test-fixtures.ts';
import { showBalance } from './act-value-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);

const ADD = { id: 'add', label: 'Add', kind: 'add', input: 'balance', repeat: 'always' } as const;
const TAKE = {
  id: 'take',
  label: 'Take',
  kind: 'take',
  input: 'balance',
  repeat: 'always',
} as const;

const balanceOf = async (passId: string) => {
  const row = await first<{ personalization: string; version: number }>(
    kit.env.DB,
    'SELECT personalization, version FROM passes WHERE id = ?',
    [passId],
  );
  return {
    balance: (JSON.parse(row?.personalization ?? '{}') as { balance?: number }).balance,
    version: row?.version ?? 0,
  };
};
const scansOf = (passId: string) =>
  rows<{ outcome: string; reason: string | null; action_kind: string; pass_version: number }>(
    'SELECT outcome, reason, action_kind, pass_version FROM scans WHERE pass_id = ? ORDER BY at, id',
    [passId],
  );
const gatesOf = (passId: string) =>
  rows<{ action_id: string; state: string }>(
    'SELECT action_id, state FROM scan_gates WHERE pass_id = ?',
    [passId],
  );
const desk = (templateIds: string[], settings: Record<string, unknown> = {}) =>
  kit.scanner({ templateIds, settings: { roleWithoutSignIn: 'desk', ...settings } });

describe('value actions: add and take', () => {
  it('adds the amount, writes the version and records the scan', async () => {
    const t = await kit.scanTemplate('Credit', { actions: [{ ...ADD, amount: 1 }] });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 5 });
    const res = await act(s.headers, codeOf(pass), { actionId: 'add' });
    expect(res.status, await res.clone().text()).toBe(200);
    const o = await out(res);
    expect(o.kind).toBe('ok');
    expect(o.value).toMatchObject({ input: 'balance', before: 5, after: 6 });
    expect(await balanceOf(pass.id)).toEqual({ balance: 6, version: pass.version + 1 });
    const [scan] = await rows<Record<string, unknown>>(
      'SELECT outcome, action_kind, amount, before_value, after_value, pass_version, state FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(scan).toMatchObject({
      outcome: 'ok',
      action_kind: 'add',
      amount: 1,
      before_value: '5',
      after_value: '6',
      pass_version: pass.version + 1,
      state: 'done',
    });
    expect(await gatesOf(pass.id)).toEqual([{ action_id: 'add', state: 'used' }]);
  });

  it('publishes a new artifact when the balance is on the pass', async () => {
    const t = await kit.scanTemplate('Shown', { actions: [{ ...ADD, amount: 2 }] });
    await showBalance(t);
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 1 });
    const before = await first<{ object_key: string }>(
      kit.env.DB,
      'SELECT object_key FROM passes WHERE id = ?',
      [pass.id],
    );
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    expect(o).toMatchObject({ kind: 'ok', value: { before: 1, after: 3 } });
    const after = await first<{ object_key: string; version: number }>(
      kit.env.DB,
      'SELECT object_key, version FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(after?.object_key).not.toBe(before?.object_key);
    expect(after?.version).toBe(pass.version + 1);
    const [v] = await rows<{ source: string | null; cause: string }>(
      'SELECT source, cause FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [pass.id],
    );
    expect(v).toEqual({ source: 'scan', cause: 'api' });
  });

  it('takes a staff-entered amount, and a short balance is no_balance with nothing written', async () => {
    const t = await kit.scanTemplate('Wallet', {
      actions: [{ ...TAKE, amount: { max: 50, presets: [5, 10], default: 5 } }],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 20 });
    const first1 = await out(await act(s.headers, codeOf(pass), { actionId: 'take', amount: 15 }));
    expect(first1).toMatchObject({ kind: 'ok', value: { before: 20, after: 5 } });
    const short = await out(await act(s.headers, codeOf(pass), { actionId: 'take', amount: 10 }));
    expect(short).toMatchObject({ kind: 'refused', reason: 'no_balance', value: { after: 5 } });
    expect(await balanceOf(pass.id)).toMatchObject({ balance: 5 });
    const scans = await scansOf(pass.id);
    expect(scans.map((r) => [r.outcome, r.reason])).toEqual([
      ['ok', null],
      ['refused', 'no_balance'],
    ]);
    // the gate is the first scan's: the refused one never took it
    expect(await gatesOf(pass.id)).toHaveLength(1);
  });

  it('caps an add at the maximum, and an add already there closes ok with no new version', async () => {
    const t = await kit.scanTemplate('Capped', { actions: [{ ...ADD, amount: 5 }] });
    await showBalance(t, { maximum: 12 });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 10 });
    const capped = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    expect(capped).toMatchObject({ kind: 'ok', value: { before: 10, after: 12 } });
    const stored = await balanceOf(pass.id);
    expect(stored.balance).toBe(12);
    const again = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    expect(again).toMatchObject({ kind: 'ok', value: { before: 12, after: 12 } });
    expect(await balanceOf(pass.id)).toEqual(stored);
    const [last] = (await scansOf(pass.id)).slice(-1);
    expect(last).toMatchObject({ outcome: 'ok', pass_version: stored.version });
  });

  it('rejects a bad amount with 422 and leaves no row', async () => {
    const t = await kit.scanTemplate('Whole', { actions: [{ ...ADD, amount: { max: 10 } }] });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 0 });
    for (const amount of [0, -1, 2.5, 5000]) {
      const idempotencyKey = key();
      const res = await act(s.headers, codeOf(pass), { actionId: 'add', amount, idempotencyKey });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe('SCAN_AMOUNT_INVALID');
      expect(
        await rows('SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey]),
      ).toHaveLength(0);
    }
  });

  it('a replay with the same key answers the same scan and applies once', async () => {
    const t = await kit.scanTemplate('Replay', { actions: [{ ...ADD, amount: 3 }] });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 0 });
    const idempotencyKey = key();
    const first1 = await out(
      await act(s.headers, codeOf(pass), { actionId: 'add', idempotencyKey }),
    );
    const replay = await out(
      await act(s.headers, codeOf(pass), { actionId: 'add', idempotencyKey }),
    );
    expect(replay).toMatchObject({ kind: 'ok', scanId: first1.scanId, replay: true });
    expect((await balanceOf(pass.id)).balance).toBe(3);
  });
});

describe('value actions: set and use_up', () => {
  const SET = {
    id: 'tier',
    label: 'Set tier',
    kind: 'set',
    input: 'tier',
    minRole: 'desk',
  } as const;

  it('sets a value, validated by the input, and a set to the current value writes no version', async () => {
    const t = await kit.scanTemplate('Tier', { actions: [SET] });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { tier: 'Silver' });
    const done = await out(await act(s.headers, codeOf(pass), { actionId: 'tier', value: 'Gold' }));
    expect(done).toMatchObject({ kind: 'ok', value: { before: 'Silver', after: 'Gold' } });
    const stored = await balanceOf(pass.id);
    const same = await out(await act(s.headers, codeOf(pass), { actionId: 'tier', value: 'Gold' }));
    expect(same).toMatchObject({ kind: 'ok', value: { before: 'Gold', after: 'Gold' } });
    expect(await balanceOf(pass.id)).toEqual(stored);
    const bad = await act(s.headers, codeOf(pass), { actionId: 'tier', value: 12 });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { code: string }).code).toBe('SCAN_VALUE_INVALID');
  });

  it('a set with a stale card version is a stale heads-up carrying the value now', async () => {
    const t = await kit.scanTemplate('Tier stale', { actions: [SET] });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { tier: 'Silver' });
    await act(s.headers, codeOf(pass), { actionId: 'tier', value: 'Gold' });
    const o = await out(
      await act(s.headers, codeOf(pass), {
        actionId: 'tier',
        value: 'Bronze',
        expectedVersion: pass.version,
      }),
    );
    expect(o).toMatchObject({ kind: 'heads_up', reason: 'stale', value: { after: 'Gold' } });
    expect(await scansOf(pass.id)).toHaveLength(2);
  });

  it('use_up voids the pass once and a second scan is voided', async () => {
    const t = await kit.scanTemplate('Coupon', {
      actions: [{ id: 'use', label: 'Use', kind: 'use_up' }],
    });
    await showBalance(t);
    const s = await desk([t]);
    const pass = await kit.scanPass(t);
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'use' }));
    expect(o.kind).toBe('ok');
    const row = await first<{ status: string }>(
      kit.env.DB,
      'SELECT status FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(row?.status).toBe('voided');
    const second = await out(await act(s.headers, codeOf(pass), { actionId: 'use' }));
    expect(second).toMatchObject({ kind: 'refused', reason: 'voided' });
    expect(await gatesOf(pass.id)).toEqual([{ action_id: 'use', state: 'used' }]);
  });
});

describe('value actions: gates, roles and approval', () => {
  it('a cooldown add held by its own gate is a cooldown heads-up and changes nothing', async () => {
    const t = await kit.scanTemplate('Cool', {
      actions: [{ ...ADD, amount: 1, repeat: 'cooldown', cooldownMinutes: 10 }],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 0 });
    await act(s.headers, codeOf(pass), { actionId: 'add' });
    const held = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    expect(held).toMatchObject({ kind: 'heads_up', reason: 'cooldown' });
    expect((await balanceOf(pass.id)).balance).toBe(1);
    kit.clock.advance(11 * 60_000);
    expect((await out(await act(s.headers, codeOf(pass), { actionId: 'add' }))).kind).toBe('ok');
    expect((await balanceOf(pass.id)).balance).toBe(2);
  });

  it('a door scanner on a desk action needs approval and writes no row', async () => {
    const t = await kit.scanTemplate('Desk only', { actions: [{ ...ADD, amount: 1 }] });
    const door = await kit.scanner({ templateIds: [t] });
    const pass = await kit.scanPass(t, { balance: 0 });
    const idempotencyKey = key();
    const o = await out(await act(door.headers, codeOf(pass), { actionId: 'add', idempotencyKey }));
    expect(o).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
    expect(await rows('SELECT id FROM scans WHERE idempotency_key = ?', [idempotencyKey])).toEqual(
      [],
    );
    expect((await balanceOf(pass.id)).balance).toBe(0);
  });

  it('a Manager PIN applies the action once, recorded as approved_by; a Desk PIN cannot approve', async () => {
    const t = await kit.scanTemplate('Approved', { actions: [{ ...ADD, amount: 1 }] });
    const door = await kit.scanner({ templateIds: [t] });
    const manager = await kit.staff('manager');
    const deskStaff = await kit.staff('desk');
    const pass = await kit.scanPass(t, { balance: 0 });
    const refused = await act(door.headers, codeOf(pass), {
      actionId: 'add',
      approval: { staffId: deskStaff.id, pin: deskStaff.pin },
    });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect((await balanceOf(pass.id)).balance).toBe(0);
    const o = await out(
      await act(door.headers, codeOf(pass), {
        actionId: 'add',
        approval: { staffId: manager.id, pin: manager.pin },
      }),
    );
    expect(o.kind).toBe('ok');
    const [scan] = await rows<{ approved_by: string | null }>(
      'SELECT approved_by FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(scan?.approved_by).toBe(manager.id);
    expect((await balanceOf(pass.id)).balance).toBe(1);
  });

  it('a desk amount above the action max needs a Manager', async () => {
    const t = await kit.scanTemplate('Max', {
      actions: [{ ...ADD, amount: { max: 5, default: 1 } }],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 0 });
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'add', amount: 9 }));
    expect(o).toMatchObject({ kind: 'heads_up', reason: 'needs_approval' });
    expect((await balanceOf(pass.id)).balance).toBe(0);
  });

  it('a daily amount cap refuses with limit_reached', async () => {
    const t = await kit.scanTemplate('Capped day', { actions: [{ ...ADD, amount: { max: 50 } }] });
    const s = await desk([t], { dailyAmount: 30 });
    const pass = await kit.scanPass(t, { balance: 0 });
    expect(
      (await out(await act(s.headers, codeOf(pass), { actionId: 'add', amount: 20 }))).kind,
    ).toBe('ok');
    const over = await out(await act(s.headers, codeOf(pass), { actionId: 'add', amount: 11 }));
    expect(over).toMatchObject({ kind: 'refused', reason: 'limit_reached' });
    expect(
      (await out(await act(s.headers, codeOf(pass), { actionId: 'add', amount: 10 }))).kind,
    ).toBe('ok');
    expect((await balanceOf(pass.id)).balance).toBe(30);
  });
});

describe('value actions: connections', () => {
  it('a connection-owned input is managed_elsewhere; with allowOnConnected it becomes manual', async () => {
    const t = await kit.scanTemplate('Connected', {
      actions: [
        { ...ADD, amount: 1 },
        {
          id: 'force',
          label: 'Force',
          kind: 'add',
          input: 'balance',
          amount: 1,
          repeat: 'always',
          allowOnConnected: true,
        },
      ],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 0 });
    await run(
      kit.env.DB,
      'UPDATE passes SET field_sources = \'{"balance":"connection"}\' WHERE id = ?',
      [pass.id],
    );
    const refused = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    expect(refused).toMatchObject({ kind: 'refused', reason: 'managed_elsewhere' });
    expect((await balanceOf(pass.id)).balance).toBe(0);
    const forced = await out(await act(s.headers, codeOf(pass), { actionId: 'force' }));
    expect(forced.kind).toBe('ok');
    const row = await first<{ field_sources: string }>(
      kit.env.DB,
      'SELECT field_sources FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(JSON.parse(row?.field_sources ?? '{}')).toEqual({ balance: 'manual' });
    await syncAfterScan(pass.id, { balance: 99 });
    expect((await balanceOf(pass.id)).balance).toBe(1);
  });
});

/** A connection record for the pass, as a sync would apply it. */
async function syncAfterScan(passId: string, fields: Record<string, number>) {
  const pass = await getPass(kit.env.DB, passId);
  if (!pass) throw new Error('Missing pass');
  const connId = kit.fx.ids.id();
  await run(
    kit.env.DB,
    `INSERT INTO connections (id, org_id, connector_type, name, created_at, updated_at) VALUES (?, ?, 'demo', 'c', 1, 1)`,
    [connId, kit.org.id],
  );
  await run(kit.env.DB, 'UPDATE passes SET connection_id = ?, external_ref = ? WHERE id = ?', [
    connId,
    'sync-after-scan',
    passId,
  ]);
  const current = await getPass(kit.env.DB, passId);
  if (!current) throw new Error('Missing pass');
  return applyConnectionRecord(jobCtxOf(kit), {
    passId,
    orgId: kit.org.id,
    mode: 'live',
    status: 'active',
    expectedVersion: current.version,
    ownerUserId: current.ownerUserId,
    linkGeneration: current.linkGeneration,
    identityId: current.identityId,
    credentialGeneration: current.credentialGeneration,
    lifecycleGeneration: current.lifecycleGeneration,
    credentialKeysetCommitment: await requireCredentialRefKeyset(kit.env.DB, kit.env),
    transferPending: false,
    connectionId: connId,
    externalRef: 'sync-after-scan',
    generation: 1,
    expectedConnectionMode: 'poll',
    fields,
    cause: 'connection',
  });
}

describe('value actions: an admin session', () => {
  it('adds and undoes as the admin, published by the user and recorded as the console', async () => {
    const t = await kit.scanTemplate('Admin credit', { actions: [{ ...ADD, amount: 3 }] });
    await showBalance(t);
    const pass = await kit.scanPass(t, { balance: 4 });
    const scope = { orgId: kit.org.id, timeZone: 'UTC' };
    const res = await kit.post(kit.admin(), '/actions', {
      scope,
      idempotencyKey: key(),
      input: codeOf(pass),
      clientTs: kit.clock.now(),
      actionId: 'add',
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const o = await out(res);
    expect(o).toMatchObject({ kind: 'ok', value: { before: 4, after: 7 } });
    expect((await balanceOf(pass.id)).balance).toBe(7);
    const [version] = await rows<{ cause: string; source: string | null }>(
      'SELECT cause, source FROM pass_versions WHERE pass_id = ? ORDER BY version DESC LIMIT 1',
      [pass.id],
    );
    expect(version).toEqual({ cause: 'admin', source: 'scan' });
    const undone = await kit.post(kit.admin(), `/scans/${o.scanId}/undo`, {
      idempotencyKey: key(),
      scope,
    });
    expect(undone.status, await undone.clone().text()).toBe(200);
    expect((await balanceOf(pass.id)).balance).toBe(4);
  });
});
