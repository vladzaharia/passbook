import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg, makePass, makeTemplate } from '../../../test/helpers/index.ts';
import {
  all,
  casUpdate,
  chunk,
  classifyD1Error,
  containsMatch,
  first,
  likeEscape,
  prefixMatch,
  run,
  type SqlMatch,
  stmt,
} from './db.ts';

describe('db helpers', () => {
  it('binds undefined as NULL, booleans as 0/1 and bytes as blobs', async () => {
    await run(
      env.DB,
      "INSERT INTO audit_log (at, actor_type, action, org_id) VALUES (1, 'system', 'x', ?)",
      [undefined],
    );
    expect(
      (
        await first<{ org_id: string | null }>(
          env.DB,
          "SELECT org_id FROM audit_log WHERE action = 'x'",
        )
      )?.org_id,
    ).toBeNull();
    const row = await first<{ v: number }>(env.DB, 'SELECT ? AS v', [true]);
    expect(row?.v).toBe(1);
    const blob = await first<{ n: number }>(env.DB, 'SELECT length(?) AS n', [
      new Uint8Array([1, 2, 3]),
    ]);
    expect(blob?.n).toBe(3);
  });

  it('runs statements atomically in a batch', async () => {
    await expect(
      env.DB.batch([
        stmt(
          env.DB,
          "INSERT INTO settings (scope, key, value, updated_at) VALUES ('platform', 'b1', '1', 1)",
        ),
        stmt(
          env.DB,
          "INSERT INTO settings (scope, key, value, updated_at) VALUES ('bogus', 'b2', '1', 1)",
        ),
      ]),
    ).rejects.toThrow();
    expect(await all(env.DB, "SELECT 1 FROM settings WHERE key = 'b1'")).toHaveLength(0);
  });

  it('applies optimistic updates only at the expected version', async () => {
    const f = fixtures(await makeEnv());
    const org = await makeOrg(f);
    const pass = await makePass(f, {
      orgId: org.id,
      template: makeTemplate({ id: 'tpl-cas' }).resolved,
    });
    expect(
      await casUpdate(env.DB, { table: 'passes', id: pass.id, version: 1 }, { display_title: 'B' }),
    ).toBe(2);
    expect(
      await casUpdate(env.DB, { table: 'passes', id: pass.id, version: 1 }, { display_title: 'C' }),
    ).toBeNull();
    expect(
      (
        await first<{ display_title: string }>(
          env.DB,
          'SELECT display_title FROM passes WHERE id = ?',
          [pass.id],
        )
      )?.display_title,
    ).toBe('B');
  });

  it('rejects unsafe identifiers', async () => {
    await expect(
      casUpdate(env.DB, { table: 'orgs', id: 'x', version: 1 }, { 'name; DROP TABLE orgs': 'x' }),
    ).rejects.toThrow(/identifier/);
  });

  it('chunks lists and escapes LIKE', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(likeEscape('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});

describe('prefixMatch and containsMatch', () => {
  const rows = async (match: SqlMatch, order = 'v') => {
    const found = await all<{ v: string }>(
      env.DB,
      `SELECT v FROM t_like WHERE ${match.sql} ORDER BY ${order}`,
      match.params,
    );
    return found.map((r) => r.v);
  };
  const long = 'abcdefghij'.repeat(6);
  const wide = 'éü日本'.repeat(12);

  it('matches any length and UTF-8, case-folding ASCII like LIKE', async () => {
    await run(env.DB, 'CREATE TABLE IF NOT EXISTS t_like (v TEXT)');
    const values = [
      `${long}-tail`,
      `${long.slice(0, 58)}zz-tail`,
      `X${long}`,
      `${wide}-tail`,
      `${wide.slice(0, -1)}x`,
      '50%_off\\',
      '50xxoff',
    ];
    for (const v of values) await run(env.DB, 'INSERT INTO t_like (v) VALUES (?)', [v]);
    expect(await rows(prefixMatch('v', long))).toEqual([`${long}-tail`]);
    expect(await rows(prefixMatch('v', long.toUpperCase()))).toEqual([`${long}-tail`]);
    expect(await rows(prefixMatch('v', wide))).toEqual([`${wide}-tail`]);
    expect(await rows(prefixMatch('v', '50%_'))).toEqual(['50%_off\\']);
    expect(await rows(containsMatch('v', long))).toEqual([`X${long}`, `${long}-tail`].sort());
    expect(await rows(containsMatch('v', `${wide.slice(0, 40)}Q`))).toEqual([]);
    expect(await rows(containsMatch('v', wide.slice(2)))).toEqual([`${wide}-tail`]);
    expect(await rows(containsMatch('v', '%_off\\'))).toEqual(['50%_off\\']);
    expect(await rows(containsMatch('v', `${'%_'.repeat(30)}`))).toEqual([]);
  });

  it('keeps short patterns as one LIKE and tags the SQL', () => {
    expect(prefixMatch('c', 'ab', 'tag')).toEqual({
      sql: "c LIKE ?/* tag */ ESCAPE '\\'",
      params: ['ab%'],
    });
    expect(containsMatch('c', 'a_').params).toEqual(['%a\\_%']);
    expect(prefixMatch('c', long).params).toHaveLength(3);
    expect(containsMatch('c', long).sql).toContain('instr(');
  });
});

describe('classifyD1Error', () => {
  const failure = async (sql: string, params: string[] = []) => {
    try {
      await run(env.DB, sql, params);
    } catch (error) {
      return classifyD1Error(error);
    }
    throw new Error('statement did not fail');
  };

  it('names the unique columns', async () => {
    await run(env.DB, 'CREATE TABLE IF NOT EXISTS t_unique (a TEXT, b TEXT, UNIQUE (a, b))');
    await run(env.DB, "INSERT INTO t_unique VALUES ('x', 'y')");
    expect(await failure("INSERT INTO t_unique VALUES ('x', 'y')")).toEqual({
      kind: 'unique',
      detail: 't_unique.a, t_unique.b',
    });
  });

  it('flags foreign key violations', async () => {
    const info = await failure(
      "INSERT INTO user_emails (email, user_id, verified_via, verified_at) VALUES ('a@b.c', 'no-user', 'oidc', 1)",
    );
    expect(info?.kind).toBe('foreign_key');
  });

  it('flags trigger aborts and ignores everything else', async () => {
    expect(
      classifyD1Error(new Error('D1_ERROR: registration cap reached: SQLITE_CONSTRAINT')),
    ).toEqual({
      kind: 'abort',
      detail: 'registration cap reached',
    });
    expect(classifyD1Error(new Error('D1_ERROR: no such table: nope'))).toBeNull();
    expect(classifyD1Error('boom')).toBeNull();
  });
});
