import { describe, expect, it } from 'vitest';
import type { PassJson } from '../../passkit/types.ts';
import { distinguishingLine } from './distinguish.ts';
import { assets } from './fixtures/index.ts';
import { normalize } from './index.ts';
import { withStatusWord } from './status-field.ts';

const pass = (extra: Record<string, unknown> = {}) =>
  ({
    formatVersion: 1,
    organizationName: 'Org',
    description: 'Membership',
    serialNumber: 's',
    passTypeIdentifier: 'pass.x',
    teamIdentifier: 'T',
    generic: {
      headerFields: [
        { key: 'tier', label: 'Tier', value: 'Pro' },
        { key: 'status', label: 'Status', value: 'Active' },
      ],
      primaryFields: [{ key: 'holder', label: 'Name', value: 'Maya Chen' }],
      backFields: [{ key: 'status', label: 'Membership status', value: 'Active' }],
    },
    ...extra,
  }) as unknown as PassJson;

const header = (p: PassJson) => p.generic?.headerFields as { key: string; value: string }[];

describe('withStatusWord', () => {
  it('replaces a static Active status, front and back, without touching the input', () => {
    const source = pass();
    const out = withStatusWord(source, 'Voided');
    expect(header(out)[1]?.value).toBe('Voided');
    expect(header(out)[0]?.value).toBe('Pro');
    expect(((out.generic?.backFields ?? []) as { value: string }[])[0]?.value).toBe('Voided');
    expect(header(source)[1]?.value).toBe('Active');
  });

  it("keeps an org's own wording and does nothing without a word", () => {
    const own = pass();
    (header(own)[1] as { value: string }).value = 'Gold member';
    expect(header(withStatusWord(own, 'Voided'))[1]?.value).toBe('Gold member');
    expect(withStatusWord(pass(), null)).toBeInstanceOf(Object);
  });
});

describe('normalize states the pass state on the card', () => {
  const view = (extra: Record<string, unknown>, stateWord?: string) =>
    normalize(pass(extra), { assets, ...(stateWord ? { stateWord } : {}) });
  const statusOf = (v: ReturnType<typeof view>) =>
    v.layout.header.find((f) => f.key === 'status')?.text;

  it('says Voided on a voided pass and Expired on an expired one', () => {
    expect(statusOf(view({ voided: true }))).toBe('Voided');
    expect(statusOf(view({ expirationDate: '2020-01-01T00:00:00Z' }))).toBe('Expired');
    expect(statusOf(view({}))).toBe('Active');
  });

  it('takes the record state over the file (removed)', () => {
    expect(statusOf(view({}, 'Removed'))).toBe('Removed');
  });
});

describe('distinguishingLine', () => {
  it('names the tier, never the holder, an id, a date or the state', () => {
    expect(distinguishingLine(pass() as unknown as Record<string, unknown>, 'Maya Chen')).toBe(
      'Tier: Pro',
    );
    expect(distinguishingLine({ generic: { primaryFields: [] } })).toBeNull();
  });

  it('skips a value equal to the title, dates, long values and non-strings', () => {
    const generic = {
      headerFields: [
        { key: 'a', label: 'Plan', value: 'Maya Chen' },
        { key: 'b', label: 'Joined', value: '2026-01-01', dateStyle: 'PKDateStyleMedium' },
        { key: 'c', label: 'Notes', value: 'x'.repeat(41) },
        { key: 'd', label: 'Count', value: 4 },
      ],
      secondaryFields: [{ key: 'e', label: 'Level', value: 'Gold' }],
    };
    expect(distinguishingLine({ generic }, 'Maya Chen')).toBe('Level: Gold');
  });
});
