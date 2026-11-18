import { describe, expect, it } from 'vitest';
import { TAG_COPY, TAG_ERROR_COPY } from '@/shared/copy/tags.ts';
import { ApiError } from '@/web/lib/errors.ts';
import { sortScanners } from './scanner-picker.tsx';
import { bindingFixture, scannerFixture, tagFixture } from './test-fixtures.tsx';
import { fill, hintSpoken, lastUsedLine, metaLine, tagErrorText, worksWithLabel } from './words.ts';

describe('tag words', () => {
  it('fills marks and drops an optional clause whose value is missing', () => {
    expect(
      fill(TAG_COPY.meta, { hint: '7F3A', date: 'Nov 3', staff: 'Ana R.', scanner: 'iPad' }),
    ).toBe('•• 7F3A · Assigned Nov 3 by Ana R. with iPad');
    expect(fill(TAG_COPY.meta, { hint: '7F3A', date: 'Nov 3', staff: null, scanner: null })).toBe(
      '•• 7F3A · Assigned Nov 3',
    );
  });

  it('reads a code digit by digit', () => {
    expect(hintSpoken('7F3A')).toBe('ends 7 F 3 A');
  });

  it('names what a tag works with', () => {
    expect(worksWithLabel(bindingFixture())).toBe(TAG_COPY.worksWith.pass);
    expect(worksWithLabel(bindingFixture({ scope: 'user', holderName: 'Maya' }))).toBe(
      "All of Maya's passes",
    );
  });

  it('builds the meta and last-used lines', () => {
    expect(metaLine(tagFixture())).toMatch(
      /^•• 7F3A · Assigned .+ by Ana R\. with Front desk iPad$/,
    );
    expect(lastUsedLine(tagFixture())).toBe(TAG_COPY.neverUsed);
    expect(lastUsedLine(tagFixture({ lastSeenAt: 1_800_000_000_000 }))).toMatch(/^Last used /);
  });

  it('orders scanners: last used, online desks, other online, then the ones that cannot', () => {
    const items = [
      scannerFixture({ id: 'a', name: 'A off', unavailable: 'offline' }),
      scannerFixture({ id: 'b', name: 'B door', role: 'door' }),
      scannerFixture({ id: 'c', name: 'C desk', role: 'desk' }),
      scannerFixture({ id: 'd', name: 'D desk', role: 'desk' }),
    ] as never;
    expect(sortScanners(items, 'b').map((s) => s.id)).toEqual(['b', 'c', 'd', 'a']);
    expect(sortScanners(items, undefined).map((s) => s.id)).toEqual(['c', 'd', 'b', 'a']);
  });

  it.each(['TAG_UNDO_EXPIRED', 'TAG_PASS_VOIDED', 'TAG_PASS_REMOVED', 'TAG_PASS_EXPIRED'] as const)(
    'shows the deck sentence for %s',
    (code) => {
      const cause = new ApiError({ status: 409, code, detail: 'server words' });
      expect(tagErrorText(cause)).toBe(TAG_ERROR_COPY[code]);
    },
  );

  it('keeps the server sentence for any other error', () => {
    const cause = new ApiError({ status: 500, code: 'boom', detail: 'server words' });
    expect(tagErrorText(cause)).toBe(cause);
  });
});
