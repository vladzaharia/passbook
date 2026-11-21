import { describe, expect, it } from 'vitest';
import { replaceOnIdentities, sqlOutsideRepo } from './check-sql-owner.ts';

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
});
