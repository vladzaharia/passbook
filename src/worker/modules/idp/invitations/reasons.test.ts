import { describe, expect, it } from 'vitest';
import { assertReason } from '../../../../../workers/passbook-id-connector/src/policy.ts';
import { INVITE_REASON } from './reasons.ts';

describe('invitation reasons', () => {
  it.each(Object.entries(INVITE_REASON))(
    'sends %s as a reason the binding accepts',
    (_name, reason) => {
      expect(assertReason(reason)).toBe(reason);
    },
  );
});
