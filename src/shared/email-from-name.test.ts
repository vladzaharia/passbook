import { describe, expect, it } from 'vitest';
import { checkFromName } from './email-from-name.ts';

type Expected = { ok: true; value: string } | { ok: false };
const ok = (value: string): Expected => ({ ok: true, value });
const refused: Expected = { ok: false };

describe('checkFromName', () => {
  it.each([
    ['plain name', 'Harbor Gym', 'PassBook', ok('Harbor Gym')],
    ['trims and collapses space', '  Harbor   Gym ', 'PassBook', ok('Harbor Gym')],
    ['strips CR and LF', 'Harbor\r\nBcc: x@y.z', 'PassBook', refused],
    ['strips CR and LF, no address left', 'Harbor\r\nGym', 'PassBook', ok('Harbor Gym')],
    ['strips controls and bidi marks', 'Har\u0000bor‮Gym ', 'PassBook', ok('Har bor Gym')],
    ['strips quotes and angle brackets', '"Harbor" <Gym>', 'PassBook', ok('Harbor Gym')],
    ['strips backslash', 'Harbor\\Gym', 'PassBook', ok('HarborGym')],
    ['keeps unicode letters', 'Café Müller', 'PassBook', ok('Café Müller')],
    ['64 characters', 'a'.repeat(64), 'PassBook', ok('a'.repeat(64))],
    ['65 characters', 'a'.repeat(65), 'PassBook', refused],
    ['empty', '', 'PassBook', refused],
    ['only unsafe characters', '"<>"\r\n', 'PassBook', refused],
    ['not a string', 42, 'PassBook', refused],
    ['an email address', 'support@harbor.test', 'PassBook', refused],
    ['an address with a name', 'Harbor <a@b.co>', 'PassBook', refused],
    ['a domain', 'harbor.test', 'PassBook', refused],
    ['the platform name', 'PassBook', 'PassBook', refused],
    ['the platform name, any case', 'PASSBOOK Support', 'PassBook', refused],
    ['the platform name, spaced', 'P a s s B o o k', 'PassBook', refused],
    ['the platform name, wide letters', 'ＰａｓｓＢｏｏｋ', 'PassBook', refused],
    ['the platform name, hyphenated', 'Pass-Book Team', 'PassBook', refused],
    ['the platform name inside a word', 'MyPassBookClub', 'PassBook', refused],
    ['org via the platform', 'Harbor Gym via PassBook', 'PassBook', ok('Harbor Gym via PassBook')],
    ['via with another suffix', 'Harbor via PassBook Support', 'PassBook', refused],
    ['platform name before via', 'PassBook via Harbor', 'PassBook', refused],
    ['a renamed platform', 'Polaris Team', 'Polaris', refused],
    ['a renamed platform, old name too', 'PassBook Team', 'Polaris', refused],
    ['a renamed platform via', 'Harbor via Polaris', 'Polaris', ok('Harbor via Polaris')],
  ] as const)('%s', (_label, raw, platform, expected) => {
    const result = checkFromName(raw, platform);
    expect(result.ok).toBe(expected.ok);
    if (expected.ok && result.ok) expect(result.value).toBe(expected.value);
    if (!result.ok) expect(result.error).not.toBe('');
  });
});
