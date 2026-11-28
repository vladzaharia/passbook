import { describe, expect, it } from 'vitest';
import { assignable, keyChecks, publishable } from './repo-grant-checks.ts';

const sqlOf = (checks: ReturnType<typeof keyChecks>) =>
  checks.map((c) => c.ok({ bind: () => '?' } as never, undefined as never));

describe('keyChecks', () => {
  it('pins a key write to Test, or to Live for a review request', () => {
    expect(sqlOf(keyChecks('api_key'))).toEqual(["a.mode = 'test'"]);
    expect(sqlOf(keyChecks('api_key', true))).toEqual(["a.mode = 'live'"]);
    expect(keyChecks('session', true)).toEqual([]);
  });
});

const render = (check: ReturnType<typeof keyChecks>[number]) => {
  const params: unknown[] = [];
  const sql = check.ok(
    {
      bind: (v: unknown) => {
        params.push(v);
        return '?';
      },
    } as never,
    undefined as never,
  );
  return { sql, params };
};

describe('assignable', () => {
  it('adds the other-org pass term only for an org destination', () => {
    const toOrg = render(assignable('t1', 'org-b'));
    expect(toOrg.params).toEqual(['t1', 'org-b']);
    expect(toOrg.sql).toContain('x.org_id != ?');
    const global = render(assignable('t1', null));
    expect(global.params).toEqual(['t1']);
    expect(global.sql).not.toContain('FROM passes x');
    expect(global.sql).not.toMatch(/IS NULL OR NOT EXISTS/);
  });
});

describe('publishable target', () => {
  const facts = (action: 'release' | 'rollback', targetReleaseId: string | null) => ({
    candidateId: 'c',
    approvalId: 'a',
    candidateHash: 'h',
    expectedStatus: 'active' as const,
    headId: null,
    action,
    targetReleaseId,
    expectedGeneration: 3,
  });
  it('a release needs no target, a rollback needs one', () => {
    const release = render(publishable(facts('release', null)));
    expect(release.sql).toContain("r.source = 'approved')");
    expect(release.params).not.toContain(3);
    expect(render(publishable(facts('release', 'r1'))).sql).toContain('AND 0');
    const rollback = render(publishable(facts('rollback', 'r1')));
    expect(rollback.params).toContain('r1');
    expect(rollback.params).toContain(3);
  });
});
