import { describe, expect, it } from 'vitest';
import { sqlOutsideRepo } from './check-sql-owner.ts';

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
});
