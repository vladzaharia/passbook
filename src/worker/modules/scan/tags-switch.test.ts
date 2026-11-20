import { describe, expect, it } from 'vitest';
import { tagsOn } from './repo-tags-resolve.ts';

const rows = (...r: { key: string; value: string }[]) => ({ results: r }) as unknown as D1Result;

describe('tag switches', () => {
  it('are on when no row is stored', () => {
    expect(tagsOn(rows())).toBe(true);
    expect(tagsOn(undefined)).toBe(true);
  });

  it('follow the org and the platform rows, independent of Apple NFC', () => {
    const org = (enabled: boolean) => ({ key: 'nfc.tags', value: JSON.stringify({ enabled }) });
    const platform = (on: boolean) => ({ key: 'nfc.tagsEnabled', value: JSON.stringify(on) });
    expect(tagsOn(rows(org(true), platform(true)))).toBe(true);
    expect(tagsOn(rows(org(false)))).toBe(false);
    expect(tagsOn(rows(org(true), platform(false)))).toBe(false);
  });
});
