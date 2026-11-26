import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTHORITY_TABLES, GUARDED_TABLES } from '../src/worker/platform/authority-tables.ts';

// The exact pins of repo-rewrap.ts over the whole tree are checked by authority-scope.test.ts.
describe('authority-scope: wallet_google_messages', () => {
  it('stays unguarded while its re-wrap update has no allowlist entry', () => {
    const source = readFileSync(
      new URL('../src/worker/modules/keys/repo-rewrap-messages.ts', import.meta.url),
      'utf8',
    );
    expect([...source.matchAll(/\bUPDATE\s+(\w+)\s+SET\b/g)].map((m) => m[1])).toEqual([
      'wallet_google_messages',
    ]);
    const guarded = new Set([...Object.keys(GUARDED_TABLES), ...AUTHORITY_TABLES]);
    expect(guarded.has('wallet_google_messages')).toBe(false);
  });
});
