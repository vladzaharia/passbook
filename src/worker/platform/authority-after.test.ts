import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { grant } from './authority.ts';
import { type AfterRead, afterRead } from './authority-after.ts';
import { passRow } from './authority-checks.ts';
import type { AuthorityError } from './authority-error.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { first } from './db.ts';

const db = env.DB;

const code = (fn: () => unknown): string | null => {
  try {
    fn();
  } catch (e) {
    return (e as AuthorityError).code;
  }
  return null;
};
const title = async (id: string) =>
  (
    await first<{ t: string | null }>(db, 'SELECT display_title AS t FROM passes WHERE id = ?', [
      id,
    ])
  )?.t;

describe('reads after a grant (commitWith)', () => {
  it('refuses a write, a second statement or a comment when the read is built', () => {
    for (const sql of [
      "INSERT INTO counters (key, window_start, count) VALUES ('k', 0, 1)",
      "UPDATE counters SET count = 0 WHERE key = 'k'",
      "DELETE FROM counters WHERE key = 'k'",
      "REPLACE INTO counters (key, window_start, count) VALUES ('k', 0, 1)",
      'SELECT 1; DELETE FROM counters',
      'SELECT 1 /* hidden */',
      'SELECT 1 -- hidden',
      'VALUES (1)',
      "WITH x AS (SELECT 1) INSERT INTO counters (key, window_start, count) SELECT 'k', 0, 1 FROM x",
    ])
      expect(
        code(() => afterRead(sql)),
        sql,
      ).toBe('GRANT_SCOPE_OVERRIDE');
    // Positive control: plain reads, including write words inside a string literal.
    for (const sql of [
      'SELECT 1',
      "SELECT 'insert into x; -- update' AS label",
      'WITH x AS (SELECT 1 AS n) SELECT n FROM x',
    ])
      expect(
        code(() => afterRead(sql)),
        sql,
      ).toBeNull();
  });

  it('refuses a statement afterRead did not build, before the batch runs', async () => {
    const { s, route, member } = await setupGrant('after-forged');
    const g = grant(route, {
      purpose: 'org_mode.pass.publish',
      principal: member(),
      checks: passRow(s.pass.id),
    });
    g.update('passes', { set: { display_title: 'forged' }, where: { id: s.pass.id } });
    const forged = { sql: "UPDATE passes SET display_title = 'x'", params: [] } as AfterRead;
    await expect(g.commitWith([forged])).rejects.toMatchObject({
      code: 'GRANT_FOREIGN_STATEMENT',
    });
    expect(await title(s.pass.id)).not.toBe('forged');
  });

  it('runs a read after the release in the same transaction, so it sees the grant writes', async () => {
    const { s, route, member } = await setupGrant('after-read');
    const g = grant(route, {
      purpose: 'org_mode.pass.publish',
      principal: member(),
      checks: passRow(s.pass.id),
    });
    g.update('passes', { set: { display_title: 'seen' }, where: { id: s.pass.id } });
    const committed = await g.commitWith([
      afterRead('SELECT display_title AS t FROM passes WHERE id = ?', [s.pass.id]),
      afterRead('SELECT count(*) AS n FROM authority_grants'),
    ]);
    expect(committed.after[0]?.results).toEqual([{ t: 'seen' }]);
    expect(committed.after[1]?.results).toEqual([{ n: 0 }]);
    expect(committed.writes).toHaveLength(1);
  });
});
