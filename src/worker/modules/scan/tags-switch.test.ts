import { describe, expect, it } from 'vitest';
import { tagsOn } from './repo-tags-resolve.ts';

const rows = (...r: { key: string; value: string }[]) => ({ results: r }) as unknown as D1Result;
const plan = (level: string) => ({ key: 'entitlement.nfc', value: JSON.stringify(level) });

describe('tag switches', () => {
  it('are on when no switch row is stored and the plan includes NFC', () => {
    expect(tagsOn(rows(plan('basic')))).toBe(true);
    expect(tagsOn(rows(plan('secure')))).toBe(true);
  });

  it('follow the org and the platform rows, independent of Apple NFC', () => {
    const org = (enabled: boolean) => ({ key: 'nfc.tags', value: JSON.stringify({ enabled }) });
    const platform = (on: boolean) => ({ key: 'nfc.tagsEnabled', value: JSON.stringify(on) });
    expect(tagsOn(rows(org(true), platform(true), plan('basic')))).toBe(true);
    expect(tagsOn(rows(org(false), plan('basic')))).toBe(false);
    expect(tagsOn(rows(org(true), platform(false), plan('basic')))).toBe(false);
  });

  it('fail closed without the plan: no row, level off or an invalid value', () => {
    expect(tagsOn(rows())).toBe(false);
    expect(tagsOn(undefined)).toBe(false);
    expect(tagsOn(rows(plan('off')))).toBe(false);
    expect(tagsOn(rows(plan('gold')))).toBe(false);
    expect(tagsOn(rows({ key: 'entitlement.nfc', value: 'not json' }))).toBe(false);
  });
});
