import { beforeAll, describe, expect, it } from 'vitest';
import { makeScanStaff } from '../../../../test/helpers/index.ts';
import { first } from '../../platform/db.ts';
import { act, kit, out, rows, setupActionFixture } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);

const ADD = {
  id: 'add',
  label: 'Add',
  kind: 'add',
  input: 'balance',
  repeat: 'always',
  amount: 1,
} as const;
const manager = (pin: string) => makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'manager', pin });
const balanceOf = async (passId: string) =>
  (
    JSON.parse(
      (
        await first<{ personalization: string }>(
          kit.env.DB,
          'SELECT personalization FROM passes WHERE id = ?',
          [passId],
        )
      )?.personalization ?? '{}',
    ) as { balance?: number }
  ).balance;

/** A door scanner (no staff sign-in) on a desk action, and a pass to add to. */
async function door() {
  const t = await kit.scanTemplate('PIN only', { actions: [ADD] });
  const s = await kit.scanner({ templateIds: [t] });
  const pass = await kit.scanPass(t, { balance: 0 });
  const add = (approval: { staffId?: string; pin: string }) =>
    act(s.headers, codeOf(pass), { actionId: 'add', approval });
  return { s, pass, add, t };
}

describe('a Manager PIN with no one named', () => {
  it('finds the manager by the PIN and records them as the approver', async () => {
    const boss = await manager('654321');
    const { pass, add } = await door();
    const res = await add({ pin: '654321' });
    expect(res.status, await res.clone().text()).toBe(200);
    const o = await out(res);
    expect(o.kind).toBe('ok');
    const [scan] = await rows<{ approved_by: string | null }>(
      'SELECT approved_by FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(scan?.approved_by).toBe(boss.id);
    expect(await balanceOf(pass.id)).toBe(1);
  });

  it('is a plain miss for a wrong PIN or a Desk PIN, and writes nothing', async () => {
    await makeScanStaff(kit.fx, { orgId: kit.org.id, role: 'desk', pin: '777888' });
    const { pass, add } = await door();
    for (const pin of ['000000', '777888']) {
      const res = await add({ pin });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('PIN_INVALID');
    }
    expect(await balanceOf(pass.id)).toBe(0);
  });

  it('refuses two managers with the same PIN, clearly', async () => {
    await manager('111222');
    await manager('111222');
    const { pass, add } = await door();
    const res = await add({ pin: '111222' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('PIN_AMBIGUOUS');
    expect(await balanceOf(pass.id)).toBe(0);
  });

  it('counts a wrong PIN like a sign-in does and locks the scanner after five', async () => {
    const { add, pass } = await door();
    const codes: string[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await add({ pin: '000001' });
      codes.push(res.status === 400 ? 'PIN_INVALID' : String(res.status));
    }
    expect(codes.slice(0, 5)).toEqual(Array(5).fill('PIN_INVALID'));
    expect(codes[5]).toBe('429');
    expect(await balanceOf(pass.id)).toBe(0);
  });

  it('works for an undo past the window', async () => {
    const boss = await manager('333444');
    const t = await kit.scanTemplate('PIN undo', { actions: [ADD] });
    const s = await kit.scanner({ templateIds: [t], settings: { roleWithoutSignIn: 'desk' } });
    const pass = await kit.scanPass(t, { balance: 0 });
    const o = await out(await act(s.headers, codeOf(pass), { actionId: 'add' }));
    kit.clock.advance(20 * 60_000);
    const res = await kit.post(s.headers, `/scans/${o.scanId}/undo`, {
      idempotencyKey: key(),
      approval: { pin: '333444' },
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await balanceOf(pass.id)).toBe(0);
    const [undo] = await rows<{ approved_by: string | null }>(
      "SELECT approved_by FROM scans WHERE undoes = ? AND action_kind = 'undo'",
      [o.scanId ?? ''],
    );
    expect(undo?.approved_by).toBe(boss.id);
  });
});
