import { describe, expect, it } from 'vitest';
import { tagsOn } from './repo-tags-resolve.ts';

const rows = (...r: { key: string; value: unknown }[]) => ({ results: r }) as unknown as D1Result;
const org = (value: unknown) => ({ key: 'nfc.tags', value: JSON.stringify(value) });
const plan = (value: string) => ({ key: 'entitlement.nfc', value: JSON.stringify(value) });
const platform = (value: unknown) => ({ key: 'nfc.tagsEnabled', value: JSON.stringify(value) });

describe('tagsOn: the bulk tag switch reads the settings as the policy does', () => {
  it('is on with no rows, and with an org row that leaves `enabled` at its default', () => {
    expect(tagsOn(rows(plan('basic')))).toBe(true);
    expect(tagsOn(rows(plan('basic'), org({})))).toBe(true);
    expect(tagsOn(rows(plan('secure'), org({ defaultType: 'type-1' })))).toBe(true);
    expect(tagsOn(rows(plan('basic'), org({ enabled: true }), platform(true)))).toBe(true);
  });

  it('is off when the plan does not include NFC', () => {
    expect(tagsOn(rows())).toBe(false);
    expect(tagsOn(rows(plan('none')))).toBe(false);
    expect(tagsOn(rows(plan('none'), org({ enabled: true })))).toBe(false);
  });

  it('is off for an explicit off, a platform row that is not true, or an unreadable row', () => {
    expect(tagsOn(rows(plan('basic'), org({ enabled: false })))).toBe(false);
    expect(tagsOn(rows(plan('basic'), org({ enabled: true }), platform(false)))).toBe(false);
    expect(tagsOn(rows({ key: 'nfc.tags', value: '{' }))).toBe(false);
    expect(tagsOn(rows({ key: 'nfc.tags', value: 5 }))).toBe(false);
  });
});
