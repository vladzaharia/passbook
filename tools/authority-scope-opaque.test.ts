// biome-ignore-all lint/suspicious/noTemplateCurlyInString: SQL and source text matched as strings
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fragmentFindings } from './authority-scope.ts';
import {
  fragmentPlacement,
  opaqueDeps,
  opaqueFindings,
  opaqueHash,
} from './authority-scope-opaque.ts';
import { OPAQUE_ALLOWLIST } from './authority-scope-opaque-allowlist.ts';

const root = new URL('..', import.meta.url).pathname;
const tree = (dir: string, out = new Map<string, string>()): Map<string, string> => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) tree(path, out);
    else if (path.endsWith('.ts')) out.set(relative(root, path), readFileSync(path, 'utf8'));
  }
  return out;
};

const WRITE = 'DELETE FROM scans WHERE id = ?';
const placement = (tail: string) => fragmentPlacement(`${WRITE} ${tail}`);

describe('authority-scope fragment placement', () => {
  it('accepts a fragment ANDed in as AND (${...})', () => {
    expect(placement('AND (${guard.sql})')).toEqual([]);
    expect(placement('AND NOT (${guard.sql})')).toEqual([]);
    expect(placement('( AND (${guard.sql})|)')).toEqual([]);
    expect(placement('AND ((${a.sql})|NOT (${b.sql}))')).toEqual([]);
    expect(placement('AND (state = ? OR (${guard.sql}))')).toEqual([]);
    expect(fragmentPlacement('UPDATE t SET x = (${count.sql}) WHERE id = ?')).toEqual([]);
    expect(placement('AND id IN (${placeholders(n)})')).toEqual([]);
  });

  it('fails an unparenthesized fragment', () => {
    expect(placement('AND ${guard.sql}')).toEqual([expect.stringContaining('not parenthesized')]);
    expect(placement('AND (${a.sql} AND ${b.sql})')).toHaveLength(2);
    expect(placement('AND (x = ? OR ${guard.sql})')).toEqual([
      expect.stringContaining('not parenthesized'),
    ]);
  });

  it('fails an OR-joined fragment', () => {
    expect(placement('OR (${guard.sql})')).toEqual([expect.stringContaining('not ANDed')]);
    expect(placement('OR NOT (${guard.sql})')).toEqual([expect.stringContaining('not ANDed')]);
    expect(placement('( OR (${guard.sql})|)')).toEqual([expect.stringContaining('not ANDed')]);
  });

  it('fails a pinned file that interpolates an unparenthesized fragment', () => {
    const source = (clause: string) =>
      `run(db, \`DELETE FROM sessions WHERE id = ?$\{guard ? \` ${clause}\` : ''}\`, []);`;
    expect(fragmentFindings(source('AND (${guard.sql})'))).toEqual([]);
    expect(fragmentFindings(source('AND ${guard.sql}'))).toEqual([
      expect.stringContaining('guard.sql} is not parenthesized'),
    ]);
    expect(fragmentFindings(source('OR (${guard.sql})'))).toEqual([
      expect.stringContaining('not ANDed'),
    ]);
  });
});

describe('authority-scope opaque deps', () => {
  const files = new Map([
    [
      'a/x.ts',
      "import { f } from './y.ts';\nimport type { T } from './t.ts';\nexport { g } from './z';",
    ],
    ['a/y.ts', 'export const f = 1;'],
    ['a/t.ts', 'export type T = 1;'],
    ['a/z.ts', 'export const g = 1;'],
  ]);

  it('takes the deps from the relative imports, not type-only imports', () => {
    expect(opaqueDeps('a/x.ts', files)).toEqual(['a/y.ts', 'a/z.ts']);
  });

  it('invalidates the pin when an imported file changes', () => {
    const before = opaqueHash('a/x.ts', files);
    expect(opaqueHash('a/x.ts', new Map([...files, ['a/y.ts', 'export const f = 2;']]))).not.toBe(
      before,
    );
    expect(opaqueHash('a/x.ts', new Map([...files, ['a/t.ts', 'export type T = 2;']]))).toBe(
      before,
    );
    const entry = { reason: 'r', exprs: ['guard.sql'], hash: before };
    expect(opaqueFindings('a/x.ts', ['guard.sql'], entry, files)).toEqual([]);
    const changed = new Map([...files, ['a/z.ts', 'export const g = 2;']]);
    expect(opaqueFindings('a/x.ts', ['guard.sql'], entry, changed)).toEqual([
      expect.stringContaining('a/x.ts, a/y.ts, a/z.ts'),
    ]);
  });

  it('adds the files an entry lists in via', () => {
    expect(opaqueDeps('a/x.ts', files, ['a/t.ts'])).toEqual(['a/t.ts', 'a/y.ts', 'a/z.ts']);
    expect(opaqueHash('a/x.ts', files, ['a/t.ts'])).not.toBe(opaqueHash('a/x.ts', files));
  });

  it('pins every opaque entry to the hash of its file and imports', () => {
    const files = tree(join(root, 'src/worker'));
    for (const [rel, entry] of Object.entries(OPAQUE_ALLOWLIST))
      expect(opaqueHash(rel, files, entry.via), rel).toBe(entry.hash);
  });
});
