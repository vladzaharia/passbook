import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE } from '../../src/worker/modules/wallet-providers/release.ts';
import {
  foldReleases,
  pendingReleaseWrites,
  type ReleaseTable,
  releaseMirrorProblems,
  releaseWrites,
} from './wallet-release-sql.ts';

const dir = resolve(import.meta.dirname, '../../migrations');
const migrations = readdirSync(dir)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => ({ name, sql: readFileSync(resolve(dir, name), 'utf8') }));
const dark = (): ReleaseTable => ({
  google: { live: 'dark', test: 'dark' },
  samsung: { live: 'dark', test: 'dark' },
});
const flip = (state: string, provider = 'google', mode = 'test') =>
  `UPDATE wallet_provider_releases SET state = '${state}', changed_at = 1764000000000 WHERE provider = '${provider}' AND mode = '${mode}';`;

describe('wallet release mirror', () => {
  it('the migrations leave the table RELEASE says, every cell dark', () => {
    expect(releaseMirrorProblems(migrations, RELEASE)).toEqual([]);
    expect(RELEASE).toEqual(dark());
    expect(foldReleases(migrations).table).toEqual({
      'google:live': 'dark',
      'google:test': 'dark',
      'samsung:live': 'dark',
      'samsung:test': 'dark',
    });
  });

  it('fails when a flip changes only one side', () => {
    const flipped = [...migrations, { name: '9999_flip.sql', sql: flip('released') }];
    expect(releaseMirrorProblems(flipped, RELEASE)).toEqual([
      'wallet release google test: the migrations leave it released, RELEASE (release.ts) says dark. Change both in one PR.',
    ]);
    const code = dark();
    code.google.test = 'released';
    expect(releaseMirrorProblems(migrations, code)).toHaveLength(1);
    expect(releaseMirrorProblems(flipped, code)).toEqual([]);
  });

  it('applies writes in migration order', () => {
    const later = [
      ...migrations,
      { name: '9998_on.sql', sql: flip('released', 'samsung', 'live') },
      { name: '9999_drain.sql', sql: flip('draining', 'samsung', 'live') },
    ];
    const code = dark();
    code.samsung.live = 'draining';
    expect(releaseMirrorProblems(later, code)).toEqual([]);
  });

  it('refuses any other way of writing the table', () => {
    for (const sql of [
      "UPDATE wallet_provider_releases SET state = 'released' WHERE provider = 'google';",
      "UPDATE wallet_provider_releases SET state = 'released', changed_at = 1;",
      "DELETE FROM wallet_provider_releases WHERE provider = 'google';",
      "INSERT OR REPLACE INTO wallet_provider_releases VALUES ('google', 'test', 'released', 0);",
      `${flip('released')}\nupdate wallet_provider_releases set state = 'dark', changed_at = 0 where provider = 'google' and mode = 'test';`,
    ])
      expect(releaseWrites('x.sql', sql).problem).toContain('outside the one form');
    // A trigger on the table and a comment are not writes.
    expect(
      releaseWrites(
        'x.sql',
        `-- UPDATE wallet_provider_releases SET state = 'released'\nCREATE TRIGGER t BEFORE UPDATE OF state ON wallet_provider_releases BEGIN SELECT 1; END;`,
      ),
    ).toEqual({ writes: [], problem: null });
  });

  it('lists what pending migrations change for the deploy log, and throws on an unreadable one', () => {
    const files: Record<string, string> = { '0300_flip.sql': flip('released'), '0301_x.sql': '' };
    expect(pendingReleaseWrites(['0300_flip.sql', '0301_x.sql'], (n) => files[n] ?? '')).toEqual([
      { migration: '0300_flip.sql', provider: 'google', mode: 'test', state: 'released' },
    ]);
    expect(pendingReleaseWrites(null, () => '')).toEqual([]);
    expect(() =>
      pendingReleaseWrites(['0302.sql'], () => 'DELETE FROM wallet_provider_releases;'),
    ).toThrow('outside the one form');
  });
});
