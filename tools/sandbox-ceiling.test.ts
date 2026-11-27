import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MINTABLE_SCOPES, PLATFORM_KEY_SCOPES } from '../src/shared/contracts/api-keys.ts';
import { SANDBOX_KEY_SCOPES } from '../src/shared/contracts/developer-home.ts';

describe('the sandbox ceiling trigger', () => {
  it('the trigger and the revoke list exactly the scopes SANDBOX_KEY_SCOPES leaves out', () => {
    // The latest migration that defines the trigger: 0183, recreated when a scope joined the list.
    const latest = readdirSync('migrations')
      .filter((f) =>
        readFileSync(`migrations/${f}`, 'utf8').includes(
          'CREATE TRIGGER api_keys_developer_scope_ceiling',
        ),
      )
      .sort()
      .at(-1);
    const sql = readFileSync(`migrations/${latest}`, 'utf8');
    const lists = [...sql.matchAll(/s\.value IN \(([^)]*)\)/g)].map((m) =>
      [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(),
    );
    // A platform scope is refused on any org-bound key by `api_keys_platform_scopes` (0231), so this list omits it.
    const left = MINTABLE_SCOPES.filter(
      (s) =>
        !(SANDBOX_KEY_SCOPES as readonly string[]).includes(s) &&
        !(PLATFORM_KEY_SCOPES as readonly string[]).includes(s),
    ).sort();
    expect(lists).toHaveLength(latest?.startsWith('0183') ? 2 : 1);
    for (const l of lists) expect(l).toEqual(left);
  });
});
