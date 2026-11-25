import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AUTHORITY_TABLES, GUARDED_TABLES } from '../src/worker/platform/authority-tables.ts';
import { rawWriteStatements } from './authority-scope.ts';
import { RAW_WRITE_ALLOWLIST } from './authority-scope-allowlists.ts';

const DIR = 'src/worker/modules/keys';
const REWRAP = `${DIR}/repo-rewrap.ts`;
const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('authority-scope: key re-wrap writes', () => {
  const files = new Map(
    [REWRAP, `${DIR}/repo-rewrap-messages.ts`, `${DIR}/repo-rewrap-older.ts`].map((f) => [
      f,
      read(f),
    ]),
  );
  const guarded = new Set([...Object.keys(GUARDED_TABLES), ...AUTHORITY_TABLES]);
  const written = (rel: string) =>
    [...(files.get(rel) ?? '').matchAll(/\bUPDATE\s+(\w+)\s+SET\b/g)].map((m) => m[1] ?? '');

  it('pins every guarded table the re-wrap updates, including through an imported constant', () => {
    const pinned = new Set((RAW_WRITE_ALLOWLIST[REWRAP]?.writes ?? []).map((w) => w.split(':')[0]));
    for (const rel of files.keys())
      for (const table of written(rel))
        if (guarded.has(table)) expect(pinned, `${rel} updates ${table}`).toContain(table);
    // The scanner sees the use of the imported constants in repo-rewrap.ts.
    expect(rawWriteStatements(files.get(REWRAP) ?? '', { rel: REWRAP, files }).length).toBe(
      (RAW_WRITE_ALLOWLIST[REWRAP]?.writes ?? []).length,
    );
  });

  it('keeps wallet_google_messages unguarded, so its re-wrap update needs no pin', () => {
    expect(written(`${DIR}/repo-rewrap-messages.ts`)).toEqual(['wallet_google_messages']);
    expect(guarded.has('wallet_google_messages')).toBe(false);
  });
});
