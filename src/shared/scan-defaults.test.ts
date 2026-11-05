import { describe, expect, it } from 'vitest';
import type { ScanAction } from '../passkit/types.ts';
import { armable, scanOf } from './scan-defaults.ts';

const only = (action: Partial<ScanAction> & Pick<ScanAction, 'kind'>) =>
  scanOf({ scan: { actions: [{ id: 'a', label: 'A', ...action }] } }).actions[0];

describe('scanOf', () => {
  it('an access template checks in on every visit', () => {
    const access = {
      input: { plan: 'plan' },
      plans: [{ id: 'all', label: 'All', kind: 'always' as const, zones: [{ zone: '*' }] }],
    };
    const actions = [
      { id: 'in', label: 'In', kind: 'check_in' as const, repeat: 'once' as const },
      { id: 'add', label: 'Add', kind: 'add' as const },
    ];
    const withAccess = scanOf({ scan: { actions, access } }).actions;
    expect(withAccess[0]?.repeat).toBe('always');
    expect(withAccess[1]?.repeat).toBe('cooldown');
    expect(scanOf({ scan: { actions } }).actions[0]?.repeat).toBe('once');
  });

  it('gives one check-in when there is no scan block', () => {
    for (const manifest of [undefined, null, {}]) {
      const { actions } = scanOf(manifest);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        id: 'check_in',
        label: 'Check in',
        kind: 'check_in',
        repeat: 'once',
        minRole: 'door',
        confirm: false,
        allowAgain: true,
        notify: false,
      });
    }
  });

  it.each([
    ['check_in', 'once', 'door', false],
    ['add', 'cooldown', 'desk', false],
    ['take', 'always', 'desk', true],
    ['set', 'always', 'manager', true],
    ['use_up', 'once', 'desk', true],
  ] as const)('defaults %s', (kind, repeat, minRole, confirm) => {
    expect(only({ kind })).toMatchObject({ repeat, minRole, confirm });
  });

  it('defaults the amount of add and take to 1 and the cooldown to 5 minutes', () => {
    expect(only({ kind: 'add' })).toMatchObject({ amount: 1, cooldownMinutes: 5 });
    expect(only({ kind: 'take' })?.amount).toBe(1);
    expect(only({ kind: 'set' })?.amount).toBeUndefined();
    expect(only({ kind: 'check_in' })?.amount).toBeUndefined();
  });

  it('keeps what the template sets', () => {
    expect(
      only({ kind: 'add', repeat: 'always', minRole: 'door', confirm: true, amount: 5 }),
    ).toMatchObject({
      repeat: 'always',
      minRole: 'door',
      confirm: true,
      amount: 5,
    });
    expect(only({ kind: 'add', repeat: 'cooldown', cooldownMinutes: 30 })?.cooldownMinutes).toBe(
      30,
    );
  });

  it('never writes the defaults back to the manifest', () => {
    const manifest = { scan: { actions: [{ id: 'a', label: 'A', kind: 'add' as const }] } };
    scanOf(manifest);
    expect(manifest.scan.actions[0]).toEqual({ id: 'a', label: 'A', kind: 'add' });
  });
});

describe('armable', () => {
  it('follows the SA 4.1 table', () => {
    expect(armable(only({ kind: 'check_in' })!)).toBe('sticky');
    expect(armable(only({ kind: 'add' })!)).toBe('sticky');
    expect(armable(only({ kind: 'add', confirm: true })!)).toBe('once');
    expect(armable(only({ kind: 'add', amount: { max: 5 } })!)).toBe('once');
    for (const kind of ['take', 'set', 'use_up'] as const)
      expect(armable(only({ kind })!)).toBeNull();
  });
});
