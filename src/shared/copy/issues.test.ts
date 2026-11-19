import { describe, expect, it } from 'vitest';
import { WARNING_CODES } from '@/passkit/warning-codes.ts';
import { ISSUE_WORDS, issueWords } from './issues.ts';

/** The params each validator supplies; the sentence must name every value. */
const SUPPLIED: Record<string, string[]> = {
  ACCESS_ZONE_UNKNOWN: ['name'],
  ASSET_NAME: ['name'],
  BARCODE_DATA: ['detail'],
  BARCODE_NO_FALLBACK: ['name'],
  BEHAVIOR_VERSION: ['name', 'found', 'wanted'],
  BINDING_TARGET: ['name'],
  COLOR_CONTRAST: ['name', 'ratio', 'min'],
  COND_INPUT: ['name'],
  COUNTER_NO_USE: ['name'],
  DISPLAY_SEARCH: ['name'],
  EXPR_INPUT: ['name'],
  EXPR_PASS: ['name'],
  FEATURED_ACTION_TYPE: ['name'],
  FIELD_COUNT: ['name', 'max'],
  FIELD_DATE_KEYS: ['name'],
  FIELD_LENGTH: ['name', 'length', 'limit'],
  FIELD_NOT_SHOWN: ['name'],
  IMAGE_BYTES: ['name', 'size'],
  IMAGE_SIZE: ['name', 'detail'],
  LOCALE_NAME: ['name'],
  LOCALIZED_IMAGES: ['name', 'locales'],
  LOGO_TEXT_PLATFORM: ['name'],
  PAPER_FIELD: ['name'],
  PAPER_INPUT: ['name'],
  PASS_SIZE: ['size'],
  PLACEHOLDER_URL: ['name'],
  PREFERRED_SCHEMES: ['name'],
  PREVIEW_ASSET: ['name'],
  SCAN_DISPLAY_CUT: ['screen'],
  SCAN_DISPLAY_IMAGE: ['source'],
  SCAN_DISPLAY_PATH: ['kind', 'name'],
  SCAN_DISPLAY_ROLE_CONDITION: ['name'],
  SCAN_DISPLAY_SHADOWED: ['name'],
  SCAN_DISPLAY_VARIANT_UNREACHABLE: ['name'],
  SEMANTICS_REQUIRED: ['name', 'missing'],
  STAMPS_ART_SMALL: ['name', 'size'],
  STAMPS_CONTRAST: ['ratio'],
  STAMPS_MAX_LOW: ['max', 'wanted'],
  STRINGS_DUPLICATE: ['name'],
  UNKNOWN_IMAGE: ['name'],
  UNKNOWN_KEY: ['name'],
  UNKNOWN_SEMANTIC_TAG: ['name'],
  URL_SCHEME: ['name'],
  WALLETS_ART_UNUSED: ['name'],
  WALLETS_INPUT: ['name'],
  WALLETS_ROLE_FIELD: ['name'],
};

describe('issueWords', () => {
  it('names every param a validator supplies', () => {
    for (const [code, keys] of Object.entries(SUPPLIED)) {
      const params = Object.fromEntries(keys.map((k) => [k, `V-${k}`]));
      const words = issueWords({ code, message: 'RAW VALIDATOR TEXT', params });
      for (const k of keys) expect(words, `${code} ${k}`).toContain(`V-${k}`);
    }
  });

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
  it('never passes a validator message through', () => {
    for (const code of WARNING_CODES) {
      const raw = 'RAW VALIDATOR TEXT';
      for (const params of [undefined, { name: 'x', kind: 'input', screen: 'ok', source: 'photo' }])
        expect(
          issueWords({ code, message: raw, ...(params ? { params } : {}) }),
          code,
        ).not.toContain(raw);
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
