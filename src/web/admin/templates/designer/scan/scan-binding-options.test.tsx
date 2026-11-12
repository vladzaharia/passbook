import { describe, expect, it } from 'vitest';
import '../../../../lib/test-utils.tsx';
import { safeScanExpression, scanBindingOptions } from './scan-fields.tsx';
import { manifest, passJson } from './scan-fields-test-fixtures.ts';

const active = (role: 'door' | 'desk' | 'manager') =>
  scanBindingOptions(manifest, role, passJson)
    .filter((o) => !o.disabled)
    .map((o) => o.value);

describe('scan binding fields', () => {
  it('excludes secrets despite x-scan overrides, filters roles and checks Wallet fields', () => {
    const options = scanBindingOptions(manifest, 'manager', passJson);
    for (const name of [
      'email',
      'phoneNumber',
      'contactName',
      'scanCode',
      'barCode',
      'wifiPassword',
      'ticket',
    ]) {
      expect(options.find((o) => o.value === `inputs.${name}`)).toMatchObject({ disabled: true });
    }
    expect(active('door')).toContain('inputs.quantity');
    expect(active('door')).not.toContain('inputs.tier');
    expect(active('desk')).toContain('inputs.tier');
    expect(active('door')).toContain('fields.member');
    expect(active('door')).not.toContain('fields.level');
    expect(active('desk')).toContain('fields.level');
    expect(active('manager')).not.toContain('fields.privatefield');
    expect(active('manager')).not.toContain('fields.reference');
    expect(active('manager')).not.toContain('history.ledger.phoneNumber.last.amount');
    expect(JSON.stringify(options)).not.toMatch(/PRIVATE_PHONE|PRIVATE_BARCODE|never@example/);
  });

  it('does not read barcode messages or literal Wallet field values', () => {
    const pass = {
      get barcodes(): never {
        throw new Error('barcode read');
      },
      generic: {
        primaryFields: [
          {
            key: 'member',
            get value(): never {
              throw new Error('field value read');
            },
          },
        ],
      },
    };
    expect(
      scanBindingOptions(manifest, 'door', pass).some(
        (option) => option.value === 'fields.member' && !option.disabled,
      ),
    ).toBe(true);
  });

  it('fails closed on incomplete barcode bindings and validates advanced expressions', () => {
    const options = scanBindingOptions(
      { ...manifest, bindings: [{ to: { barcode: 0, prop: 'message' }, value: '{{ticket' }] },
      'manager',
      passJson,
    );
    expect(options.find((o) => o.value === 'inputs.quantity')).toMatchObject({ disabled: true });
    expect(options.some((o) => o.value.startsWith('fields.'))).toBe(false);
    const available = scanBindingOptions(manifest, 'desk', passJson);
    expect(safeScanExpression('Tier {{inputs.tier|upper}}', available)).toBe(true);
    expect(safeScanExpression('{{phoneNumber}}', available)).toBe(false);
    expect(safeScanExpression('{{inputs.scanCode}}', available)).toBe(false);
    expect(safeScanExpression('{{inputs.quantity|html}}', available)).toBe(false);
    expect(safeScanExpression('{{inputs.quantity', available)).toBe(false);
    expect(safeScanExpression('Contact person@example.test', available)).toBe(false);
    expect(safeScanExpression('+1 212 555 0199', available)).toBe(false);
    expect(safeScanExpression('{"private":"data"}', available)).toBe(false);
    expect(safeScanExpression('{{inputs.quantity}}'.repeat(9), available)).toBe(false);
  });
});
