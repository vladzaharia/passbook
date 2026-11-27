import { describe, expect, it } from 'vitest';
import { errorCode, signCauseOf } from './record-helpers.ts';

const coded = (code: string) => Object.assign(new Error('x'), { code });

describe("a failed record's code", () => {
  it('keeps a stable code the record earned', () => {
    expect(errorCode(coded('PASS_CONFLICT'))).toBe('PASS_CONFLICT');
  });

  it('stays RECORD_ERROR for a signing refusal, which the log names instead', () => {
    const refusal = coded('SIGN_CHAIN_INVALID');
    expect(errorCode(refusal)).toBe('RECORD_ERROR');
    expect(signCauseOf(refusal)).toEqual({ causeCode: 'SIGN_CHAIN_INVALID' });
    expect(signCauseOf(coded('PASS_CONFLICT'))).toEqual({});
    expect(errorCode(new Error('plain'))).toBe('RECORD_ERROR');
  });
});
