import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { installSqlRecorder, stmt } from './db.ts';

describe('SQL recorder', () => {
  it('stays off without the test binding', () => {
    const seen: string[] = [];
    expect(installSqlRecorder({}, (sql) => seen.push(sql))).toBeNull();
    expect(installSqlRecorder({ SQL_CORPUS: '0' }, (sql) => seen.push(sql))).toBeNull();
    stmt(env.DB, 'SELECT 1');
    expect(seen).toEqual([]);
  });

  it('records statements once the binding is on, and can be removed', () => {
    const seen: string[] = [];
    const restore = installSqlRecorder(env as unknown as { SQL_CORPUS?: string }, (sql) =>
      seen.push(sql),
    );
    expect(restore).not.toBeNull();
    stmt(env.DB, 'SELECT 41');
    restore?.();
    stmt(env.DB, 'SELECT 42');
    expect(seen).toEqual(['SELECT 41']);
  });

  it('is on only in the test bindings', () => {
    expect((env as unknown as { SQL_CORPUS?: string }).SQL_CORPUS).toBe('1');
  });
});
