import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { fixtures, makeEnv, makeOrg, makePass, makeTemplate } from '../../../test/helpers/index.ts';
import { all, casUpdate, chunk, classifyD1Error, first, likeEscape, run, stmt } from './db.ts';

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
