import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeScanStaff, TEST_NOW } from '../../../../test/helpers/index.ts';
import { expectSecretAbsent } from '../../../../test/helpers/secret-absent.ts';
import { first } from '../../platform/db.ts';
import { act, kit, out, rows, setupActionFixture } from './act-test-fixtures.ts';
import { codeOf, key } from './test-kit.ts';

beforeAll(setupActionFixture);
// A PIN's counters are windowed by the clock: each test starts in a fresh hour, all within one UTC day.
let tick = 0;
beforeEach(() => kit.clock.set(TEST_NOW + ++tick * 61 * 60_000));

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
    for (const pin of ['000000', '777888']) {
      const { pass, add } = await door();
      const res = await add({ pin });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('PIN_INVALID');
      expect(await balanceOf(pass.id)).toBe(0);
    }
  });

  it('answers two managers with one PIN exactly as a wrong PIN, and tells the log', async () => {
    await manager('111222');
    await manager('111222');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const wrong = await (await door()).add({ pin: '000002' });
      const { pass, add } = await door();
      const both = await add({ pin: '111222' });
      const strip = async (res: Response) => {
        const body = (await res.json()) as Record<string, unknown>;
        return { status: res.status, code: body.code, detail: body.detail, issues: body.issues };
      };
      expect(await strip(both)).toEqual(await strip(wrong));
      expect(await balanceOf(pass.id)).toBe(0);
      const lines = [...warn.mock.calls, ...log.mock.calls, ...err.mock.calls].map((c) =>
        String(c[0]),
      );
      const logged = lines.find((line) => line.includes('scan.pin_ambiguous'));
      expect(logged).toContain(kit.org.id);
      expectSecretAbsent(logged, '111222');
    } finally {
      warn.mockRestore();
      log.mockRestore();
      err.mockRestore();
    }
  });

  it('costs a PIN-only miss one guess per manager tested, on the scanner and on the org', async () => {
    const [{ n }] = (await rows<{ n: number }>(
      "SELECT COUNT(*) AS n FROM scan_staff WHERE org_id = ? AND role = 'manager' AND disabled_at IS NULL",
      [kit.org.id],
    )) as [{ n: number }];
    const burst = Math.max(1, Math.floor(5 / n));
    const { add } = await door();
    const codes: string[] = [];
    for (let i = 0; i < burst + 1; i++) {
      const res = await add({ pin: '000001' });
      codes.push(res.status === 400 ? 'PIN_INVALID' : String(res.status));
    }
    expect(codes).toEqual([...Array(burst).fill('PIN_INVALID'), '429']);
    // another device of the same org: only the org's hourly budget is left
    const orgBudget = Math.max(1, Math.floor(20 / n));
    let used = burst;
    let locked = false;
    for (let i = 0; i < orgBudget + 1 && !locked; i++) {
      const res = await (await door()).add({ pin: '000003' });
      if (res.status === 429) locked = true;
      else used++;
    }
    expect(locked).toBe(true);
    expect(used).toBe(orgBudget);
  });

  it('asks for the manager when the scanner has staff sign-in on', async () => {
    const t = await kit.scanTemplate('Named only', { actions: [ADD] });
    const s = await kit.scanner({ templateIds: [t], settings: { staffSignIn: true } });
    const pass = await kit.scanPass(t, { balance: 0 });
    const clerk = await kit.staff('door');
    const signedIn = await kit.post(s.headers, '/staff', { staffId: clerk.id, pin: clerk.pin });
    expect(signedIn.status, await signedIn.clone().text()).toBe(200);
    const res = await act(s.headers, codeOf(pass), {
      actionId: 'add',
      approval: { pin: '123456' },
    });
    expect(res.status, await res.clone().text()).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('PIN_MANAGER_REQUIRED');
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
