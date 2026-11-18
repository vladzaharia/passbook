/** The one set of rules for an org's From display name. Server write, send time and the form use it. */

export const FROM_NAME_MAX = 64;
/** Always protected, whatever the platform sender name is set to. */
export const PLATFORM_NAME = 'PassBook';

/** Line and paragraph separators and control characters read as a space. */
const BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
/** Invisible format characters (bidi, zero width, tags) and the blank Hangul fillers vanish. */
const INVISIBLE = /[\p{Cf}ᅟᅠㅤﾠ]+/gu;
const QUOTES_BRACKETS = /["'`‘’“”<>\\]/gu;

export type FromNameResult = { ok: true; value: string } | { ok: false; error: string };

/** Lookalike letters and digits to one Latin skeleton (applied to both sides of a comparison). */
const SKELETON: Record<string, string> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  к: 'k',
  м: 'm',
  н: 'h',
  т: 't',
  в: 'b',
  і: 'l',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ӏ: 'l',
  ѵ: 'v',
  α: 'a',
  ο: 'o',
  ρ: 'p',
  ν: 'v',
  τ: 't',
  κ: 'k',
  ι: 'l',
  β: 'b',
  ε: 'e',
  υ: 'u',
  η: 'n',
  χ: 'x',
  ς: 's',
  μ: 'u',
  '0': 'o',
  '1': 'l',
  '|': 'l',
  '5': 's',
  i: 'l',
  '!': 'l',
  $: 's',
  '@': 'a',
};

/**
 * Case, width, accents and lookalikes folded away; spaces and punctuation dropped. "P a s s-B00k",
 * "РassВook" and "PassBook" share one skeleton.
 */
export function skeleton(value: string): string {
  const mapped = [
    ...value
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .toLowerCase(),
  ]
    .map((ch) => SKELETON[ch] ?? ch)
    .join('');
  return mapped.replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Scripts a name's letters are told apart by; any other letter counts as one more script. */
const SCRIPTS = [
  'Latin',
  'Cyrillic',
  'Greek',
  'Armenian',
  'Cherokee',
  'Georgian',
  'Hebrew',
  'Arabic',
  'Thai',
  'Devanagari',
  'Han',
  'Hiragana',
  'Katakana',
  'Hangul',
  'Bopomofo',
] as const;
const SCRIPT_TESTS = SCRIPTS.map(
  (name) => [name, new RegExp(`^\\p{Script=${name}}$`, 'u')] as const,
);
/** UTS #39 allows these together: the scripts of Japanese, Korean and Chinese text. */
const ALLOWED_MIXES: ReadonlySet<string>[] = [
  new Set(['Han', 'Hiragana', 'Katakana']),
  new Set(['Han', 'Hangul']),
  new Set(['Han', 'Bopomofo']),
];

/** True when letters come from more than one script (Common and Inherited marks do not count). */
export function mixesScripts(value: string): boolean {
  const found = new Set<string>();
  for (const ch of value) {
    if (!/^\p{L}$/u.test(ch) || /^[\p{Script=Common}\p{Script=Inherited}]$/u.test(ch)) continue;
    found.add(SCRIPT_TESTS.find(([, test]) => test.test(ch))?.[0] ?? `other:${ch}`);
  }
  if (found.size < 2) return false;
  return !ALLOWED_MIXES.some((allowed) => [...found].every((script) => allowed.has(script)));
}

/**
 * Cleans a From name or refuses it. Strips control, format and filler characters, quotes and angle
 * brackets; refuses an empty result, one over 64 characters, anything that looks like an email
 * address or domain, and any name whose skeleton contains a platform name. The server adds
 * " via <platform name>" itself, so a tenant never sets that part.
 */
export function checkFromName(raw: unknown, platformName: string = PLATFORM_NAME): FromNameResult {
  if (typeof raw !== 'string') return { ok: false, error: 'Enter a name.' };
  const value = raw
    .normalize('NFKC')
    .replace(BREAKS, ' ')
    .replace(INVISIBLE, '')
    .replace(QUOTES_BRACKETS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) return { ok: false, error: 'Enter a name.' };
  if (value.length > FROM_NAME_MAX)
    return { ok: false, error: `Use ${FROM_NAME_MAX} characters or fewer.` };
  if (value.includes('@') || /[\p{L}\p{N}-]+\.\p{L}{2,}/u.test(value))
    return { ok: false, error: 'Use a name, not an email address or domain.' };
  if (mixesScripts(value)) return { ok: false, error: 'Use one alphabet in the name.' };
  const folded = skeleton(value);
  for (const platform of new Set([PLATFORM_NAME, platformName])) {
    const needle = skeleton(platform);
    if (needle && folded.includes(needle))
      return { ok: false, error: `Do not use the name ${platform}.` };
  }
  return { ok: true, value };
}

/** What the recipient sees: the org's part, then the platform's attribution (never dropped). */
export function displayFromName(orgPart: string, platformName?: string | null): string {
  return `${orgPart} via ${platformName?.trim() || PLATFORM_NAME}`;
}
