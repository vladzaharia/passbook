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
    [
      'control reads as a space, bidi vanishes',
      'Har\u0000bor\u202eGym ',
      'PassBook',
      ok('Har borGym'),
    ],
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
    ['via is no longer allowed', 'Harbor Gym via PassBook', 'PassBook', refused],
    ['Cyrillic lookalikes', '\u0420ass\u0412ook', 'PassBook', refused],
    ['Cyrillic and digit swaps', '\u0420ass\u0412\u043e\u043ek', 'PassBook', refused],
    ['digit swaps', 'PassB00k', 'PassBook', refused],
    ['I and l swaps', 'Pa55B0ok', 'PassBook', refused],
    ['Greek lookalikes', 'P\u03b1ssB\u03bf\u03bfk', 'PassBook', refused],
    ['Hangul filler inside', 'Pass\u3164Book', 'PassBook', refused],
    ['Hangul half-width filler', 'Pass\uffa0Book', 'PassBook', refused],
    ['Hangul fillers 115F and 1160', 'Pass\u115f\u1160Book', 'PassBook', refused],
    ['zero-width inside', 'Pass\u200bBook', 'PassBook', refused],
    ['tag characters inside', 'Pass\u{e0041}Book', 'PassBook', refused],
    ['Arabic letter mark inside', 'Pass\u061cBook', 'PassBook', refused],
    ['combining marks', 'P\u0301assBook', 'PassBook', refused],
    ['invisible times inside', 'Pass\u2062Book', 'PassBook', refused],
    ['an IDN domain', 'paypal.\u0440\u0444', 'PassBook', refused],
    ['an accented domain', 'caf\u00e9.example', 'PassBook', refused],
    ['invisible marks only', '\u200b\u3164\uffa0', 'PassBook', refused],
    ['invisible marks around a name', '\u200bHarbor\u2062 Gym\ufeff', 'PassBook', ok('Harbor Gym')],
    ['a renamed platform', 'Polaris Team', 'Polaris', refused],
    ['a renamed platform, old name too', 'PassBook Team', 'Polaris', refused],
    ['a renamed platform, lookalike', 'Po1aris Desk', 'Polaris', refused],
  ] as const)('%s', (_label, raw, platform, expected) => {
    const result = checkFromName(raw, platform);
    expect(result.ok).toBe(expected.ok);
    if (expected.ok && result.ok) expect(result.value).toBe(expected.value);
    if (!result.ok) expect(result.error).not.toBe('');
  });
});
