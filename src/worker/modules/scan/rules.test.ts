import { describe, expect, it } from 'vitest';
import {
  effectiveRole,
  overridePolicyKind,
  type PolicyActor,
  type PolicyRequest,
  ROLE_RANK,
  scanPolicy,
} from './rules.ts';

const actor = (over: Partial<PolicyActor> = {}): PolicyActor => ({
  principal: 'scanner',
  role: 'door',
  terminal: false,
  actorKey: 's:1',
  staffId: null,
  settings: { lookup: true, letInAgain: 'anyone' },
  ...over,
});
const door = actor();
const desk = actor({ role: 'desk' });
const manager = actor({ role: 'manager' });
const admin = actor({ principal: 'admin', role: 'manager', actorKey: 'u:1' });
const terminal = actor({ role: 'desk', terminal: true });
const allowed = (a: PolicyActor, r: PolicyRequest, approved = false) => scanPolicy(a, r, approved);

describe('effectiveRole (SA 2.2)', () => {
  const settings = { roleWithoutSignIn: 'door', staffSignIn: false } as const;
  it('admin is manager', () =>
    expect(effectiveRole({ principal: 'admin', staffRole: null, settings })).toBe('manager'));
  it('a signed-in person brings their role only when sign-in is enabled', () => {
    expect(
      effectiveRole({
        principal: 'scanner',
        staffRole: 'desk',
        settings: { ...settings, staffSignIn: true },
      }),
    ).toBe('desk');
    expect(effectiveRole({ principal: 'scanner', staffRole: 'manager', settings })).toBe('door');
  });
  it('nobody signed in uses roleWithoutSignIn', () =>
    expect(effectiveRole({ principal: 'scanner', staffRole: null, settings })).toBe('door'));
  it('sign-in required and missing is null', () =>
    expect(
      effectiveRole({
        principal: 'scanner',
        staffRole: null,
        settings: { ...settings, staffSignIn: true },
      }),
    ).toBeNull());
  it('orders door < desk < manager', () =>
    expect([ROLE_RANK.door, ROLE_RANK.desk, ROLE_RANK.manager]).toEqual([0, 1, 2]));
});

describe('scanPolicy: Matrix B', () => {
  it('lookup by code: everyone', () => {
    for (const a of [door, desk, manager, admin, terminal])
      expect(allowed(a, { kind: 'lookup' })).toEqual({ allow: true });
  });

  it('search: not on a terminal, not when lookup is off', () => {
    expect(allowed(door, { kind: 'search' }).allow).toBe(true);
    expect(allowed(terminal, { kind: 'search' })).toEqual({ allow: false, why: 'forbidden' });
    expect(
      allowed(actor({ settings: { lookup: false, letInAgain: 'anyone' } }), { kind: 'search' })
        .allow,
    ).toBe(false);
  });

  it('action with minRole at or under the role', () => {
    expect(allowed(door, { kind: 'act', minRole: 'door' }).allow).toBe(true);
    expect(allowed(desk, { kind: 'act', minRole: 'desk' }).allow).toBe(true);
    expect(allowed(terminal, { kind: 'act', minRole: 'desk' }).allow).toBe(true);
  });

  it('action above the role: approval for people, never for a terminal', () => {
    const req: PolicyRequest = { kind: 'act', minRole: 'manager' };
    expect(allowed(door, req)).toEqual({ allow: false, why: 'needs_approval' });
    expect(allowed(desk, req)).toEqual({ allow: false, why: 'needs_approval' });
    expect(allowed(desk, req, true).allow).toBe(true);
    expect(allowed(manager, req).allow).toBe(true);
    expect(allowed(admin, req).allow).toBe(true);
    expect(allowed(terminal, req)).toEqual({ allow: false, why: 'forbidden' });
    expect(allowed(terminal, req, true)).toEqual({ allow: false, why: 'forbidden' });
  });

  it('amount above max', () => {
    const over: PolicyRequest = { kind: 'act', minRole: 'desk', amount: 11, max: 10 };
    const at: PolicyRequest = { kind: 'act', minRole: 'desk', amount: 10, max: 10 };
    expect(allowed(desk, at).allow).toBe(true);
    expect(allowed(desk, over)).toEqual({ allow: false, why: 'needs_approval' });
    expect(allowed(desk, over, true).allow).toBe(true);
    expect(allowed(manager, over).allow).toBe(true);
    expect(allowed(terminal, over).allow).toBe(false);
  });

  it('check out and bundle check-in: not on a terminal', () => {
    for (const kind of ['check_out', 'bundle'] as const) {
      expect(allowed(door, { kind }).allow).toBe(true);
      expect(allowed(terminal, { kind }).allow).toBe(false);
    }
  });

  it('let in again follows the setting', () => {
    const set = (letInAgain: 'anyone' | 'manager' | 'never', base = door) =>
      actor({ ...base, settings: { lookup: true, letInAgain } });
    expect(allowed(set('anyone'), { kind: 'let_in_again' }).allow).toBe(true);
    expect(allowed(set('anyone', terminal), { kind: 'let_in_again' }).allow).toBe(false);
    expect(allowed(set('manager'), { kind: 'let_in_again' })).toEqual({
      allow: false,
      why: 'needs_approval',
    });
    expect(allowed(set('manager'), { kind: 'let_in_again' }, true).allow).toBe(true);
    expect(allowed(set('manager', manager), { kind: 'let_in_again' }).allow).toBe(true);
    expect(allowed(set('manager', terminal), { kind: 'let_in_again' })).toEqual({
      allow: false,
      why: 'forbidden',
    });
    expect(allowed(set('never', manager), { kind: 'let_in_again' }).allow).toBe(false);
  });

  it('cooldown override needs a manager', () => {
    expect(allowed(desk, { kind: 'cooldown_override' })).toEqual({
      allow: false,
      why: 'needs_approval',
    });
    expect(allowed(desk, { kind: 'cooldown_override' }, true).allow).toBe(true);
    expect(allowed(manager, { kind: 'cooldown_override' }).allow).toBe(true);
    expect(allowed(terminal, { kind: 'cooldown_override' }).allow).toBe(false);
  });

  it('a capacity override always needs a manager, even when anyone may let a pass in again', () => {
    expect(door.settings.letInAgain).toBe('anyone');
    expect(allowed(door, { kind: 'let_in_again' }).allow).toBe(true);
    expect(allowed(door, { kind: 'capacity_override' })).toEqual({
      allow: false,
      why: 'needs_approval',
    });
    expect(allowed(desk, { kind: 'capacity_override' }, true).allow).toBe(true);
    expect(allowed(manager, { kind: 'capacity_override' }).allow).toBe(true);
    expect(allowed(admin, { kind: 'capacity_override' }).allow).toBe(true);
    expect(allowed(terminal, { kind: 'capacity_override' }).allow).toBe(false);
    expect(overridePolicyKind('capacity_full')).toBe('capacity_override');
    expect(overridePolicyKind('cooldown')).toBe('cooldown_override');
    expect(overridePolicyKind('already_done')).toBe('let_in_again');
  });

  describe('undo', () => {
    const now = 1_000_000_000;
    const own = (ageMin: number) => ({
      kind: 'undo' as const,
      now,
      undoWindowMinutes: 10,
      scan: { actorKey: 's:1', staffId: null, at: now - ageMin * 60_000, sameScannerToday: true },
    });
    const other = (over: Partial<{ sameScannerToday: boolean; at: number }> = {}) => ({
      kind: 'undo' as const,
      now,
      undoWindowMinutes: 10,
      scan: {
        actorKey: 's:2',
        staffId: null,
        at: now - 3_600_000,
        sameScannerToday: true,
        ...over,
      },
    });
    it('own scan inside the window, even on a terminal', () => {
      expect(allowed(door, own(9)).allow).toBe(true);
      expect(allowed(terminal, own(9)).allow).toBe(true);
      expect(allowed(door, own(11)).allow).toBe(false);
    });
    it("an own scan past the window is judged like anyone's (Matrix B)", () => {
      const adminOwn = actor({ principal: 'admin', role: 'manager', actorKey: 's:1' });
      expect(allowed(adminOwn, own(15)).allow).toBe(true);
      expect(allowed(adminOwn, own(25 * 60)).allow).toBe(false);
      expect(allowed(manager, own(11)).allow).toBe(true);
      expect(allowed(door, own(11))).toEqual({ allow: false, why: 'needs_approval' });
      expect(allowed(desk, own(11), true).allow).toBe(true);
      expect(allowed(terminal, own(11))).toEqual({ allow: false, why: 'forbidden' });
      expect(
        allowed(door, { ...own(11), scan: { ...own(11).scan, sameScannerToday: false } }),
      ).toEqual({ allow: false, why: 'forbidden' });
    });
    it('own means the same staff member when one is signed in', () => {
      const staffed = actor({ staffId: 'a' });
      const r = { ...own(1), scan: { ...own(1).scan, staffId: 'b' } };
      expect(allowed(staffed, r).allow).toBe(false);
    });
    it('another scan on this scanner, same day: approval; manager free; terminal no', () => {
      expect(allowed(door, other())).toEqual({ allow: false, why: 'needs_approval' });
      expect(allowed(door, other(), true).allow).toBe(true);
      expect(allowed(manager, other()).allow).toBe(true);
      expect(allowed(terminal, other())).toEqual({ allow: false, why: 'forbidden' });
      expect(allowed(door, other({ sameScannerToday: false })).allow).toBe(false);
    });
    it('admin: any scan of the org within 24 h', () => {
      expect(allowed(admin, other({ sameScannerToday: false })).allow).toBe(true);
      expect(allowed(admin, other({ at: now - 25 * 3_600_000 })).allow).toBe(false);
    });
  });

  it('a terminal sees the summary only', () => {
    expect(allowed(terminal, { kind: 'card' })).toEqual({ allow: true, view: 'summary' });
    expect(allowed(door, { kind: 'card' })).toEqual({ allow: true });
  });
});
