import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeScanStaff, TEST_NOW } from '../../../../test/helpers/index.ts';
import { run } from '../../platform/db.ts';
import { act, kit, out, rows, setupActionFixture } from './act-test-fixtures.ts';
import { signIn } from './overrides-test-fixtures.ts';
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

describe('a person never approves their own request', () => {
  const MGR_ADD = { ...ADD, id: 'madd', label: 'Manager add', minRole: 'manager' } as const;
  async function signedIn(role: 'desk' | 'manager') {
    const t = await kit.scanTemplate('Self', { actions: [MGR_ADD] });
    const s = await kit.scanner({
      templateIds: [t],
      settings: { approvals: 'desk', staffSignIn: true },
    });
    const me = await staff(role, role === 'desk' ? '121212' : '343434');
    await signIn(s.id, me.id);
    const pass = await kit.scanPass(t, { balance: 0 });
    return (approval: { staffId?: string; pin: string }) =>
      act(s.headers, codeOf(pass), { actionId: 'madd', approval });
  }

  it('refuses a Desk member who types their own PIN, and takes a colleague', async () => {
    const mine = await signedIn('desk');
    const me = (
      await rows<{ id: string }>(
        "SELECT id FROM scan_staff WHERE role='desk' ORDER BY rowid DESC LIMIT 1",
      )
    )[0];
    expect(await codeOfBody(await mine({ staffId: me?.id ?? '', pin: '121212' }))).toBe(
      'PIN_INVALID',
    );
    const colleague = await staff('desk', '565656');
    const again = await signedIn('desk');
    const res = await again({ staffId: colleague.id, pin: '565656' });
    expect(res.status, await res.clone().text()).toBe(200);
  });
});

describe('a PIN shared by a Manager and a Desk member', () => {
  const approver = async (res: Response) => {
    expect(res.status, await res.clone().text()).toBe(200);
    const o = await out(res);
    const [scan] = await rows<{ approved_by: string | null }>(
      'SELECT approved_by FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    return scan?.approved_by;
  };

  it('is the Manager with no one named, and the named person when one is', async () => {
    const boss = await staff('manager', '787878');
    const deskStaff = await staff('desk', '787878');
    expect(await approver(await (await door('desk')).run('add', '787878'))).toBe(boss.id);
    const named = await (await door('desk')).run('add', '787878', {
      approval: { staffId: deskStaff.id, pin: '787878' },
    });
    expect(await approver(named)).toBe(deskStaff.id);
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

describe('the only staff who can approve may approve their own request, with a confirm', () => {
  const MGR_ADD = { ...ADD, id: 'sadd', label: 'Manager add', minRole: 'manager' } as const;
  async function alone(role: 'desk' | 'manager', pin: string, others: boolean) {
    const t = await kit.scanTemplate('Sole', { actions: [MGR_ADD] });
    const s = await kit.scanner({
      templateIds: [t],
      settings: { approvals: 'desk', staffSignIn: true },
    });
    const me = await staff(role, pin);
    await signIn(s.id, me.id);
    // Only `me` is active: every earlier member of the org is disabled.
    await run(kit.env.DB, 'UPDATE scan_staff SET disabled_at = ? WHERE org_id = ? AND id != ?', [
      kit.clock.now(),
      kit.org.id,
      me.id,
    ]);
    if (others) await staff('desk', `${pin.slice(0, 5)}9`);
    const pass = await kit.scanPass(t, { balance: 0 });
    return {
      me,
      send: (approval: Record<string, unknown>) =>
        act(s.headers, codeOf(pass), { actionId: 'sadd', approval }),
    };
  }

  it('needs alone: true, then records the requester as approver and audits it', async () => {
    const { me, send } = await alone('desk', '246802', false);
    const refused = await send({ staffId: me.id, pin: me.pin });
    expect(refused.status).not.toBe(200);
    const res = await send({ staffId: me.id, pin: me.pin, alone: true });
    expect(res.status, await res.clone().text()).toBe(200);
    const o = await out(res);
    expect(o.kind).toBe('ok');
    const [scan] = await rows<{ approved_by: string | null }>(
      'SELECT approved_by FROM scans WHERE id = ?',
      [o.scanId ?? ''],
    );
    expect(scan?.approved_by).toBe(me.id);
    const audit = await rows<{ detail: string }>(
      "SELECT detail FROM audit_log WHERE action = 'scan.approved_alone' AND target_id = ?",
      [o.scanId ?? ''],
    );
    expect(JSON.parse(audit[0]?.detail ?? '{}')).toMatchObject({ kind: 'sole', staffId: me.id });
  });

  it('is refused while another staff member can approve: two staff mean two people', async () => {
    const { me, send } = await alone('desk', '135791', true);
    expect((await send({ staffId: me.id, pin: me.pin, alone: true })).status).not.toBe(200);
  });
});
