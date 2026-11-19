import { describe, expect, it } from 'vitest';
import { WARNING_CODES } from '@/passkit/warning-codes.ts';
import { ISSUE_WORDS, issueWords } from './issues.ts';

describe('issueWords', () => {
  it('has admin words for every warning code', () => {
    expect(Object.keys(ISSUE_WORDS).sort()).toEqual([...WARNING_CODES].sort());
    for (const code of WARNING_CODES) {
      const words = issueWords({
        code,
        message: 'Validator words.',
        params: { name: 'x', kind: 'input', screen: 'ok', source: 'photo' },
      });
      expect(words.length, code).toBeGreaterThan(0);
      expect(words, code).not.toMatch(/\b(undefined|\$\{)/);
    }
  });
  it('words the scan screen issues from their params, not their text', () => {
    const at = (code: string, params: Record<string, string>) =>
      issueWords({ code, message: 'ignored', params });
    expect(at('SCAN_DISPLAY_SHADOWED', { name: 'access' })).toBe(
      'The scan screen shows the built-in "access", not your input. Use inputs.access for the input.',
    );
    expect(at('SCAN_DISPLAY_CUT', { screen: 'not ok' })).toBe(
      'Some rows do not fit on the not ok screen and are cut.',
    );
    expect(at('SCAN_DISPLAY_VARIANT_UNREACHABLE', { name: 'VIP' })).toBe(
      '"VIP" never shows. An earlier variant always matches first.',
    );
    expect(at('SCAN_DISPLAY_ROLE_CONDITION', { name: 'plan' })).toBe(
      'Staff who see this cannot see the plan input, so the rule never matches.',
    );
    expect(at('SCAN_DISPLAY_PATH', { kind: 'input', name: 'x' })).toBe(
      'There is no input "x" on this template.',
    );
    expect(at('SCAN_DISPLAY_IMAGE', { source: 'photo' })).toBe('The template has no photo image.');
  });
  it('stays general without params and leaves other codes alone', () => {
    expect(
      issueWords({ code: 'SCAN_DISPLAY_SHADOWED', message: 'Input "access" is hidden.' }),
    ).toBe(
      'An input shares a name with a built-in scan value, so the scan screen shows the built-in.',
    );
    expect(issueWords({ code: 'OTHER', message: 'As is.' })).toBe('As is.');
  });
});
