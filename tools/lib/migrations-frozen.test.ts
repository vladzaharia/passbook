import { describe, expect, it } from 'vitest';
import { frozenFailures } from './migrations-frozen.ts';

const base = new Map([
  ['migrations/0001_a.sql', 'CREATE TABLE a (id TEXT);\n'],
  ['migrations/0002_b.sql', 'CREATE TABLE b (id TEXT);\n'],
]);

describe('frozen migrations', () => {
  it('passes when every base migration is unchanged', () => {
    expect(frozenFailures({ base, read: (f) => base.get(f) ?? null })).toEqual([]);
  });

  it('refuses a base migration edited in place', () => {
    const read = (f: string) =>
      f === 'migrations/0002_b.sql'
        ? 'CREATE TABLE b (id TEXT);\nALTER TABLE b ADD x;\n'
        : (base.get(f) ?? null);
    expect(frozenFailures({ base, read })).toEqual([
      'migrations/0002_b.sql: changed, but it is on the base ref (production may have applied it; add a new migration)',
    ]);
  });

  it('refuses a deleted base migration', () => {
    const read = (f: string) => (f === 'migrations/0001_a.sql' ? null : (base.get(f) ?? null));
    expect(frozenFailures({ base, read })).toEqual([
      'migrations/0001_a.sql: deleted, but it is on the base ref (add a new migration instead)',
    ]);
  });
});
