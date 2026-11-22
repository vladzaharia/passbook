import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MINTABLE_SCOPES } from '../src/shared/contracts/api-keys.ts';
import { SANDBOX_KEY_SCOPES } from '../src/shared/contracts/developer-home.ts';

describe('migration 0183 and the sandbox ceiling', () => {
  it('the trigger and the revoke list exactly the scopes SANDBOX_KEY_SCOPES leaves out', () => {
    const sql = readFileSync('migrations/0183_developer_key_ceiling.sql', 'utf8');
    const lists = [...sql.matchAll(/s\.value IN \(([^)]*)\)/g)].map((m) =>
      [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(),
    );
    const left = MINTABLE_SCOPES.filter(
      (s) => !(SANDBOX_KEY_SCOPES as readonly string[]).includes(s),
    ).sort();
    expect(lists).toHaveLength(2);
    for (const l of lists) expect(l).toEqual(left);
  });
});
