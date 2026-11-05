import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../types.ts';
import {
  actionGoals,
  hiddenFieldKeys,
  inputVisibleTo,
  nameSegments,
  scopeCatalog,
  secretInputs,
} from './scope.ts';
import { manifestOf } from './test-kit.ts';

const inputs = {
  holder: { type: 'string' },
  tier: { type: 'string', 'x-scan': 'desk' },
  phone: { type: 'string' },
  wifiPassword: { type: 'string' },
  pinCode: { type: 'string', 'x-scan': 'manager' },
  email: { type: 'string', format: 'email', 'x-scan': 'door' },
  site: { type: 'string', format: 'uri' },
  cardNumber: { type: 'string' },
  notes: { type: 'string', 'x-scan': 'hidden' },
};

describe('secrets', () => {
  const manifest = manifestOf(inputs);
  manifest.bindings = [
    { to: { field: 'tier' }, value: '{{tier}}' },
    { to: { field: 'contact' }, value: '{{phone}} / {{holder}}' },
    { to: { field: 'who' }, value: '{{pass.scanCode}}' },
    { to: { barcode: '*', prop: 'message' }, value: '{{cardNumber}}' },
  ];

  it('splits camel and snake names', () => {
    expect(nameSegments('wifiPassword')).toEqual(['wifi', 'password']);
    expect(nameSegments('guest_pin')).toEqual(['guest', 'pin']);
  });

  it('removes contact formats, secret names and barcode-only inputs for every role', () => {
    const secrets = secretInputs(manifest);
    expect([...secrets].sort()).toEqual(['cardNumber', 'email', 'phone', 'site', 'wifiPassword']);
    for (const role of ['door', 'desk', 'manager'] as const) {
      const paths = scopeCatalog(manifest, role);
      for (const name of secrets) expect(paths).not.toContain(`inputs.${name}`);
    }
  });

  it('lets an explicit x-scan opt a name-matched input back in, never a format', () => {
    expect(secretInputs(manifest).has('pinCode')).toBe(false);
    expect(inputVisibleTo('pinCode', inputs.pinCode, 'manager')).toBe(true);
    expect(inputVisibleTo('email', inputs.email, 'manager')).toBe(false);
  });

  it('filters by x-scan level', () => {
    expect(scopeCatalog(manifest, 'door')).not.toContain('inputs.tier');
    expect(scopeCatalog(manifest, 'desk')).toContain('inputs.tier');
    expect(scopeCatalog(manifest, 'manager')).not.toContain('inputs.notes');
    expect(scopeCatalog(manifest, 'door')).not.toContain('pass.externalId');
    expect(scopeCatalog(manifest, 'desk')).toContain('pass.externalId');
  });

  it('hides fields that read a secret, a pass binding or the barcode message', () => {
    const passJson = {
      barcodes: [{ format: 'PKBarcodeFormatQR', message: 'CARD-1', messageEncoding: 'utf-8' }],
      generic: {
        primaryFields: [
          { key: 'tier', value: 'Gold' },
          { key: 'contact', value: '555' },
          { key: 'who', value: 'abc' },
          { key: 'code', value: 'CARD-1' },
        ],
      },
    } as unknown as PassJson;
    expect([...hiddenFieldKeys(manifest, passJson)].sort()).toEqual(['code', 'contact', 'who']);
  });
});

describe('goals', () => {
  it('takes goal and reward from the take action by input', () => {
    const manifest = manifestOf(
      { stamps: { type: 'integer' } },
      {
        actions: [
          { id: 'add_stamp', label: 'Add stamp', kind: 'add', input: 'stamps' },
          {
            id: 'redeem',
            label: 'Redeem',
            kind: 'take',
            input: 'stamps',
            amount: 10,
            rewardLabel: 'Free coffee',
          },
        ],
      },
    );
    expect(actionGoals(manifest)).toEqual({ stamps: { goal: 10, reward: 'Free coffee' } });
  });
});
