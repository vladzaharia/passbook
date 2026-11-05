import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../passkit/types.ts';
import { normalize } from './normalize.ts';
import { validityOf } from './validity.ts';

const now = new Date('2026-11-05T12:00:00Z');
const base = {
  formatVersion: 1,
  passTypeIdentifier: 'pass.test',
  teamIdentifier: 'T',
  serialNumber: 's',
  description: 'd',
  organizationName: 'o',
  generic: { primaryFields: [] },
} as unknown as PassJson;

describe('validityOf', () => {
  it('is active without voided or expirationDate', () => {
    expect(validityOf(base, now)).toEqual({ status: 'active', validFrom: null, validUntil: null });
  });

  it('is voided when voided is true, and voided wins over expired', () => {
    expect(validityOf({ ...base, voided: true }, now).status).toBe('voided');
    const both = { ...base, voided: true, expirationDate: '2026-10-01T00:00:00Z' };
    expect(validityOf(both, now).status).toBe('voided');
  });

  it('is expired once expirationDate is before now, and reports it as validUntil in ms', () => {
    const v = validityOf({ ...base, expirationDate: '2026-10-01T00:00:00Z' }, now);
    expect(v).toEqual({
      status: 'expired',
      validFrom: null,
      validUntil: Date.parse('2026-10-01T00:00:00Z'),
    });
  });

  it('is active until the expiry instant has passed', () => {
    const at = '2026-11-05T12:00:00Z';
    expect(validityOf({ ...base, expirationDate: at }, now).status).toBe('active');
    expect(validityOf({ ...base, expirationDate: '2027-01-01T00:00:00Z' }, now).status).toBe(
      'active',
    );
  });

  it('ignores an unparseable expirationDate', () => {
    expect(validityOf({ ...base, expirationDate: 'garbage' }, now)).toEqual({
      status: 'active',
      validFrom: null,
      validUntil: null,
    });
  });

  it('agrees with normalize for every state', () => {
    const cases: Partial<PassJson>[] = [
      {},
      { voided: true },
      { expirationDate: '2026-10-01T00:00:00Z' },
      { expirationDate: '2027-01-01T00:00:00Z' },
      { expirationDate: 'garbage' },
      { voided: true, expirationDate: '2026-10-01T00:00:00Z' },
    ];
    for (const extra of cases) {
      const pass = { ...base, ...extra } as PassJson;
      const view = normalize(pass, { assets: {}, now });
      const { status, validUntil } = validityOf(pass, now);
      expect(view.voided).toBe(status === 'voided');
      expect(view.expired).toBe(validUntil !== null && validUntil < now.getTime());
      expect(view.invalid).toBe(status === 'active' ? null : status);
    }
  });
});
