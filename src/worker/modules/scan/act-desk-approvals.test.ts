import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeScanStaff, TEST_NOW } from '../../../../test/helpers/index.ts';
import { act, kit, out, rows, setupActionFixture } from './act-test-fixtures.ts';
import { deskMayApprove } from './rules.ts';
import { codeOf } from './test-kit.ts';

beforeAll(setupActionFixture);
// A PIN's counters are windowed by the clock: each test starts in a fresh hour.
let tick = 0;
beforeEach(() => kit.clock.set(TEST_NOW + 200_000 * 60_000 + ++tick * 61 * 60_000));

const ADD = {
  id: 'add',
  label: 'Add',
  kind: 'add',
  input: 'balance',
  repeat: 'always',
  amount: 1,
} as const;
const SET = { id: 'tier', label: 'Set tier', kind: 'set', input: 'tier', minRole: 'desk' } as const;
const staff = (role: 'door' | 'desk' | 'manager', pin: string) =>
  makeScanStaff(kit.fx, { orgId: kit.org.id, role, pin });

/** A door with no sign-in, on desk actions, with the session's Approvals setting. */
async function door(approvals: 'managers' | 'desk' | undefined) {
  const t = await kit.scanTemplate('Approvals', { actions: [ADD, SET] });
  const s = await kit.scanner({
    templateIds: [t],
    settings: approvals ? { approvals } : {},
  });
  const pass = await kit.scanPass(t, { balance: 0, tier: 'Silver' });
  const run = (actionId: string, pin: string, extra: Record<string, unknown> = {}) =>
    act(s.headers, codeOf(pass), { actionId, approval: { pin }, ...extra });
  return { run };
}
const codeOfBody = async (res: Response) => ((await res.json()) as { code: string }).code;

describe('approvals × role × setting', () => {
  it.each([undefined, 'managers'] as const)(
    'with Approvals %s only a Manager PIN approves',
    async (setting) => {
      const n = setting ? '1' : '2';
      const desk = await staff('desk', `31130${n}`);
      const boss = await staff('manager', `42240${n}`);
      const { run } = await door(setting);
      expect(await codeOfBody(await run('add', desk.pin))).toBe('PIN_INVALID');
      const res = await run('add', boss.pin);
      expect(res.status).toBe(200);
      expect((await out(res)).kind).toBe('ok');
    },
  );

  it('with Approvals on Desk staff a Desk PIN approves, and is the recorded approver', async () => {
    const deskStaff = await staff('desk', '551133');
    const { run } = await door('desk');
    const res = await run('add', deskStaff.pin);
    expect(res.status, await res.clone().text()).toBe(200);
    const o = await out(res);
    expect(o.kind).toBe('ok');
    const [scan] = await rows<{ approved_by: string | null }>(
      'SELECT approved_by FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(scan?.approved_by).toBe(deskStaff.id);
  });

  it('with Approvals on Desk staff a Manager PIN still approves', async () => {
    const boss = await staff('manager', '662244');
    const { run } = await door('desk');
    expect((await out(await run('add', boss.pin))).kind).toBe('ok');
  });

  it('a Door PIN never approves, whatever the setting', async () => {
    const doorStaff = await staff('door', '773355');
    const { run } = await door('desk');
    expect(await codeOfBody(await run('add', doorStaff.pin))).toBe('PIN_INVALID');
  });

  it('a set never relaxes: a Desk PIN is refused for it, a Manager PIN is not', async () => {
    const deskStaff = await staff('desk', '884466');
    const boss = await staff('manager', '995577');
    const refused = await door('desk');
    expect(await codeOfBody(await refused.run('tier', deskStaff.pin, { value: 'Gold' }))).toBe(
      'PIN_INVALID',
    );
    const res = await (await door('desk')).run('tier', boss.pin, { value: 'Gold' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect((await out(res)).kind).toBe('ok');
  });
});

describe('deskMayApprove', () => {
  it('needs the setting, and never for a set or an amount over its max', () => {
    expect(deskMayApprove({ approvals: 'desk' }, { kind: 'add' }, false)).toBe(true);
    expect(deskMayApprove({ approvals: 'desk' }, { kind: 'check_in' }, false)).toBe(true);
    expect(deskMayApprove({ approvals: 'desk' }, { kind: 'set' }, false)).toBe(false);
    expect(deskMayApprove({ approvals: 'desk' }, { kind: 'add' }, true)).toBe(false);
    expect(deskMayApprove({ approvals: 'managers' }, { kind: 'add' }, false)).toBe(false);
    expect(deskMayApprove({}, { kind: 'add' }, false)).toBe(false);
  });
});
