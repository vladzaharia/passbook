import { beforeAll, describe, expect, it } from 'vitest';
import { first } from '../../platform/db.ts';
import { act, kit, out, rows, setupActionFixture } from './act-test-fixtures.ts';
import { showBalance } from './act-value-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);

const ADD = { id: 'add', label: 'Add', kind: 'add', input: 'balance', repeat: 'always' } as const;
const desk = (templateIds: string[]) =>
  kit.scanner({ templateIds, settings: { roleWithoutSignIn: 'desk' } });
const undoScan = (headers: Record<string, string>, scanId: string | null) =>
  kit.post(headers, `/scans/${scanId}/undo`, { idempotencyKey: key() });
const passOf = async (id: string) => {
  const row = await first<{ personalization: string; status: string; version: number }>(
    kit.env.DB,
    'SELECT personalization, status, version FROM passes WHERE id = ?',
    [id],
  );
  const input = JSON.parse(row?.personalization ?? '{}') as { balance?: number; tier?: string };
  return { ...input, status: row?.status, version: row?.version ?? 0 };
};

describe('undo of value scans', () => {
  it('undoes an add: the value goes back, the gate returns, the undo row and event are written', async () => {
    const t = await kit.scanTemplate('Undo add', {
      actions: [{ ...ADD, amount: 4, repeat: 'cooldown', cooldownMinutes: 30 }],
    });
    await showBalance(t);
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 10 });
    const scan = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    expect((await passOf(pass.id)).balance).toBe(14);
    const res = await undoScan(s.headers, scan.scanId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe('ok');
    const after = await passOf(pass.id);
    expect(after.balance).toBe(10);
    expect(after.version).toBe(pass.version + 2);
    const [target] = await rows<{ undone_by: string | null }>(
      'SELECT undone_by FROM scans WHERE id = ?',
      [scan.scanId ?? ''],
    );
    expect(target?.undone_by).toEqual(expect.any(String));
    expect(
      await rows('SELECT 1 FROM scan_gates WHERE pass_id = ? AND action_id = ?', [pass.id, 'add']),
    ).toEqual([]);
    expect(
      await rows("SELECT 1 FROM pass_events WHERE pass_id = ? AND kind = 'scan.undone'", [pass.id]),
    ).toHaveLength(1);
    // the cooldown is free again
    expect((await out(await act(s.headers, codeOf(pass), { actionId: 'add' }))).kind).toBe('ok');
    expect((await passOf(pass.id)).balance).toBe(14);
  });

  it('undoes a capped add by what it changed, and a take by giving it back', async () => {
    const t = await kit.scanTemplate('Undo capped', {
      actions: [
        { ...ADD, amount: 5 },
        { id: 'take', label: 'Take', kind: 'take', input: 'balance', amount: 3, repeat: 'always' },
      ],
    });
    await showBalance(t, { maximum: 12 });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 10 });
    const capped = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    expect((await passOf(pass.id)).balance).toBe(12);
    await undoScan(s.headers, capped.scanId);
    expect((await passOf(pass.id)).balance).toBe(10);
    const taken = await out(await act(s.headers, codeOf(pass), { actionId: 'take' }));
    expect((await passOf(pass.id)).balance).toBe(7);
    await undoScan(s.headers, taken.scanId);
    expect((await passOf(pass.id)).balance).toBe(10);
  });

  it('undoes a set only while the value is still the one it wrote', async () => {
    const t = await kit.scanTemplate('Undo set', {
      actions: [
        {
          id: 'tier',
          label: 'Tier',
          kind: 'set',
          input: 'tier',
          minRole: 'desk',
          repeat: 'cooldown',
          cooldownMinutes: 1,
        },
      ],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { tier: 'Silver' });
    const first1 = await out(
      await act(s.headers, codeOf(pass), { actionId: 'tier', value: 'Gold' }),
    );
    expect((await passOf(pass.id)).tier).toBe('Gold');
    const res = await undoScan(s.headers, first1.scanId);
    expect(res.status).toBe(200);
    expect((await passOf(pass.id)).tier).toBe('Silver');
    // a second set, then someone changes the value by hand: the undo is superseded
    kit.clock.advance(2 * 60_000);
    const second = await out(
      await act(s.headers, codeOf(pass), { actionId: 'tier', value: 'Gold' }),
    );
    await kit.env.DB.prepare(
      `UPDATE passes SET personalization = json_set(personalization, '$.tier', 'Platinum') WHERE id = ?`,
    )
      .bind(pass.id)
      .run();
    const blocked = await undoScan(s.headers, second.scanId);
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { code: string }).code).toBe('UNDO_SUPERSEDED');
    expect((await passOf(pass.id)).tier).toBe('Platinum');
  });

  it('undoes a use up: the pass is active again and a repeat is allowed; a later void supersedes', async () => {
    const t = await kit.scanTemplate('Undo coupon', {
      actions: [{ id: 'use', label: 'Use', kind: 'use_up' }],
    });
    const s = await desk([t]);
    const pass = await kit.scanPass(t);
    const used = await out(await act(s.headers, codeOf(pass), { actionId: 'use' }));
    expect((await passOf(pass.id)).status).toBe('voided');
    const res = await undoScan(s.headers, used.scanId);
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await passOf(pass.id)).status).toBe('active');
    const again = await out(await act(s.headers, codeOf(pass), { actionId: 'use' }));
    expect(again.kind).toBe('ok');
    // the first use is already undone; the second is the gate's now
    const stale = await undoScan(s.headers, used.scanId);
    expect(stale.status).toBeGreaterThanOrEqual(400);
    expect((await passOf(pass.id)).status).toBe('voided');
  });

  it('an undo racing a later scan is UNDO_SUPERSEDED and changes nothing', async () => {
    const t = await kit.scanTemplate('Undo race', { actions: [{ ...ADD, amount: 1 }] });
    const s = await desk([t]);
    const pass = await kit.scanPass(t, { balance: 0 });
    const first1 = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    await act(s.headers, codeOf(pass), { actionId: 'add' });
    const res = await undoScan(s.headers, first1.scanId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('UNDO_SUPERSEDED');
    expect((await passOf(pass.id)).balance).toBe(2);
  });
});

describe('undo past the window', () => {
  it('needs a Manager PIN past the window, and applies once with it', async () => {
    const t = await kit.scanTemplate('Undo approved', { actions: [{ ...ADD, amount: 2 }] });
    const s = await desk([t]);
    const manager = await kit.staff('manager');
    const pass = await kit.scanPass(t, { balance: 1 });
    const scan = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    kit.clock.advance(20 * 60_000);
    const refused = await undoScan(s.headers, scan.scanId);
    expect(refused.status).toBe(403);
    expect((await passOf(pass.id)).balance).toBe(3);
    const approved = await kit.post(s.headers, `/scans/${scan.scanId}/undo`, {
      idempotencyKey: key(),
      approval: { staffId: manager.id, pin: manager.pin },
    });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect((await passOf(pass.id)).balance).toBe(1);
  });
});
