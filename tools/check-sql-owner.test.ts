import { describe, expect, it } from 'vitest';
import {
  optionalBindPredicate,
  presenceStamp,
  replaceOnIdentities,
  sqlOutsideRepo,
} from './check-sql-owner.ts';

describe('check-sql-owner', () => {
  it('flags SQL in a service and allows it in repo files', () => {
    const text = "run(db, 'DELETE FROM x WHERE a = ?')";
    expect(sqlOutsideRepo('src/worker/modules/a/service.ts', text)).toMatch(/outside a repo/);
    expect(sqlOutsideRepo('src/worker/modules/a/repo-sync.ts', text)).toBeNull();
    expect(sqlOutsideRepo('src/worker/platform/workflow-runs.ts', text)).toBeNull();
  });

  it('refuses the presence stamp outside the anchor builder, its guard and their tests', () => {
    const text = 'WHERE ao.authority_present_k7 = 1';
    expect(presenceStamp('src/worker/modules/scan/repo-feed.ts', text)).toMatch(/presence stamp/);
    expect(presenceStamp('src/worker/modules/scan/read-corpus.test.ts', text)).toMatch(
      /presence stamp/,
    );
    expect(presenceStamp('src/worker/platform/authority-restrict.ts', text)).toMatch(
      /presence stamp/,
    );
    for (const ok of [
      'authority-read.ts',
      'authority-read-once.ts',
      'authority-read-shape.ts',
      'authority-read-join-guard.test.ts',
    ])
      expect(presenceStamp(`src/worker/platform/${ok}`, text)).toBeNull();
    expect(
      presenceStamp('src/worker/modules/scan/repo-feed.ts', 'WHERE ao.present = 1'),
    ).toBeNull();
  });

  it('ignores prose', () => {
    expect(sqlOutsideRepo('src/worker/modules/a/service.ts', '// select the first row')).toBeNull();
  });

  it('flags REPLACE on signing_identities in any worker file', () => {
    const text = "run(db, 'INSERT OR REPLACE INTO signing_identities (id) VALUES (?)')";
    expect(replaceOnIdentities('src/worker/modules/identities/repo.ts', text)).toMatch(/replaces/);
    expect(replaceOnIdentities('src/worker/modules/identities/repo.test.ts', text)).toBeNull();
    expect(replaceOnIdentities('src/worker/modules/a/repo.ts', 'INSERT INTO x')).toBeNull();
  });

  it('flags a bound parameter that switches a filter off, with file:line', () => {
    const rel = 'src/worker/modules/a/repo.ts';
    const flagged = (sql: string) => optionalBindPredicate(rel, `const q = \`${sql}\`;`);
    for (const sql of [
      'WHERE (? IS NULL OR org_id = ?)',
      'WHERE x = ? AND (org_id = ? OR ? IS NULL)',
      'WHERE (NULL IS ? OR a = ?)',
      'WHERE (?3 IS NULL OR a = ?3)',
      'WHERE a = ? AND ? = NULL',
      'WHERE a = COALESCE(?, a)',
      'WHERE a = IFNULL(?, a)',
      'WHERE ISNULL(?)',
      "WHERE (? = '' OR a = ?)",
      'WHERE CASE WHEN ? THEN 1 END',
      'WHERE NOT (? IS NOT NULL AND a = ?)',
      'WHERE x = ?\n  AND (?\n   IS NULL\n   OR org_id = ?)',
    ])
      expect(flagged(sql), sql).toHaveLength(1);
    expect(flagged('WHERE a = ?\n AND (? IS NULL OR b = ?)')[0]).toMatch(/^src\/.*repo\.ts:2 /);
  });

  it('ignores comments, tests, fixtures and nullable-column checks', () => {
    const rel = 'src/worker/modules/a/repo.ts';
    const sql = "q('WHERE (? IS NULL OR org_id = ?)')";
    expect(optionalBindPredicate(rel, `// ${sql}\n/* ${sql} */`)).toEqual([]);
    expect(optionalBindPredicate(rel, `/*\n${sql}\n*/\nconst a = \`? IS NULL\`;`)[0]).toContain(
      ':4 ',
    );
    expect(optionalBindPredicate('src/worker/modules/a/repo.test.ts', sql)).toEqual([]);
    expect(optionalBindPredicate('src/worker/modules/a/x-test-support.ts', sql)).toEqual([]);
    expect(optionalBindPredicate('src/worker/modules/a/x-fixtures.ts', sql)).toEqual([]);
    expect(optionalBindPredicate('src/web/a.ts', sql)).toEqual([]);
    expect(optionalBindPredicate(rel, "'WHERE (pass_id IS NULL OR pass_id = ?)'")).toEqual([]);
  });

  it('flags a bind interpolated through a helper, not a column helper', () => {
    const rel = 'src/worker/platform/a.ts';
    const at = (text: string) => optionalBindPredicate(rel, text.replaceAll('@', '$'));
    for (const text of [
      'const s = `(@{p(destinationOrgId)} IS NULL OR NOT EXISTS (SELECT 1))`;',
      'const s = `(k.org_id IS NULL OR @{b.bind(named)} IS NULL OR k.org_id = @{b.bind(named)})`;',
      'const s = `@{bind(x)} IS NOT NULL`;',
    ])
      expect(at(text), text).toHaveLength(1);
    for (const text of [
      'const s = `(@{value} IS NULL OR @{exists})`;',
      'const s = `(@{key} IS NULL OR @{rowBody(table, alias, key)})`;',
      'const s = `(@{col} IS NULL OR @{renderCond(q, c, v, params)})`;',
      'const s = `@{p(x)} = 1 AND (@{col} IS NULL OR y)`;',
    ])
      expect(at(text), text).toEqual([]);
  });

  it('catches flag, subselect and NULLIF forms', () => {
    const rel = 'src/worker/modules/a/repo.ts';
    for (const sql of [
      'WHERE (? = 0 OR org_id = ?)',
      'WHERE ((SELECT ?) IS NULL OR org_id = ?)',
      "WHERE org_id = IFNULL(NULLIF(?, ''), org_id)",
      "WHERE (? = 'all' OR org_id = ?)",
      'WHERE (? > 0 OR org_id = ?)',
      'WHERE (? OR org_id = ?)',
      'WHERE (org_id = ? OR ?)',
    ])
      expect(optionalBindPredicate(rel, `const q = \`${sql}\`;`), sql).toHaveLength(1);
  });

  it('pins each reviewed line by its text, and reports a new one at its own line', () => {
    const rel = 'src/worker/platform/workflow-runs.ts';
    const reviewed = 'run_guard = CASE WHEN ? THEN NULL ELSE run_guard END';
    expect(optionalBindPredicate(rel, `x\n  ${reviewed}\ny`)).toEqual([]);
    const added = `${reviewed}\nWHERE (? IS NULL OR org_id = ?)`;
    const found = optionalBindPredicate(rel, added);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/workflow-runs\.ts:2 /);
    // The same new predicate in place of a reviewed line is still a finding.
    expect(optionalBindPredicate(rel, 'WHERE (? IS NULL OR org_id = ?)')).toHaveLength(1);
  });
});
