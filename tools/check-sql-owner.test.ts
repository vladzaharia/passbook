import { describe, expect, it } from 'vitest';
import { optionalBindPredicate, replaceOnIdentities, sqlOutsideRepo } from './check-sql-owner.ts';

describe('check-sql-owner', () => {
  it('flags SQL in a service and allows it in repo files', () => {
    const text = "run(db, 'DELETE FROM x WHERE a = ?')";
    expect(sqlOutsideRepo('src/worker/modules/a/service.ts', text)).toMatch(/outside a repo/);
    expect(sqlOutsideRepo('src/worker/modules/a/repo-sync.ts', text)).toBeNull();
    expect(sqlOutsideRepo('src/worker/platform/workflow-runs.ts', text)).toBeNull();
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

  it('flags a "? IS NULL OR" predicate in worker code, across lines, but not tests', () => {
    const one = "first(db, 'SELECT 1 FROM t WHERE (? IS NULL OR org_id = ?)', [a, a])";
    const split = 'WHERE x = ?\n  AND (?\n   IS NULL\n   OR org_id = ?)';
    expect(optionalBindPredicate('src/worker/modules/a/repo.ts', one)).toMatch(/IS NULL OR/);
    expect(optionalBindPredicate('src/worker/modules/a/repo.ts', split)).toMatch(/IS NULL OR/);
    expect(optionalBindPredicate('src/worker/modules/a/repo.test.ts', one)).toBeNull();
    expect(optionalBindPredicate('src/web/a.ts', one)).toBeNull();
  });

  it('allows a nullable column check', () => {
    const text = "'WHERE (pass_id IS NULL OR pass_id = ?)'";
    expect(optionalBindPredicate('src/worker/modules/a/repo.ts', text)).toBeNull();
  });
});
