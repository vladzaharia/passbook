/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';
import { ENTITLEMENT_KEYS, entitlementDef } from '../../shared/contracts/entitlements.ts';

const sources = import.meta.glob<string>(['./**/*.ts', '!./**/*.test.ts', '!./**/*-test-*.ts'], {
  eager: true,
  query: '?raw',
  import: 'default',
});

/** `domains` joins when the custom-domain add path exists (MT9). */
const LATER = new Set(['domains']);

describe('every create limit of the registry is enforced', () => {
  const limits = ENTITLEMENT_KEYS.filter((k) => entitlementDef(k).kind === 'limit');

  it.each(limits.filter((k) => !LATER.has(k)))('%s names its enforcement site', (key) => {
    // A `withinLimit(` call naming the key, or the plan condition of a statement that is not a grant.
    const call = new RegExp(`withinLimit\\([^)]*'${key}'|v\\.key = '${key}'`);
    const sites = Object.entries(sources)
      .filter(([, text]) => call.test(text))
      .map(([file]) => file);
    expect(sites, `no module enforces '${key}'`).not.toEqual([]);
  });

  it('only a listed limit is left to a later package', () => {
    expect([...LATER].every((k) => limits.includes(k as (typeof limits)[number]))).toBe(true);
  });
});
