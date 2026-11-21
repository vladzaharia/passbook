import { describe, expect, it } from 'vitest';
import { displayFromName } from '../../../shared/email-from-name.ts';
import { passEmailOrgName } from './email-from.ts';

describe('passEmailOrgName', () => {
  it('uses the org name for an ordinary org', () => {
    expect(passEmailOrgName({ name: 'Harbor Gym', personal: false })).toBe('Harbor Gym');
  });
  it("uses the platform name for a personal org, never its owner's name", () => {
    expect(passEmailOrgName({ name: 'Pat Owner', personal: true })).toBe('PassBook');
  });
  it('uses the platform name when the org is gone', () => {
    expect(passEmailOrgName(null)).toBe('PassBook');
  });
});

describe('displayFromName', () => {
  it('does not repeat the platform name', () => {
    expect(displayFromName('PassBook', 'PassBook')).toBe('PassBook');
    expect(displayFromName('Harbor Gym', 'PassBook')).toBe('Harbor Gym via PassBook');
  });
});
