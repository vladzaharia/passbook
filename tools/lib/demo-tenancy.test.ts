import { describe, expect, it } from 'vitest';
import { buildBootstrap } from './bootstrap-tenancy.ts';
import { DEMO_OWNER, tenancyCommand } from './demo-tenancy.ts';

describe('demo tenancy', () => {
  it('applies the bootstrap to the local D1 only', () => {
    const { args } = tenancyCommand(DEMO_OWNER);
    expect(args).toContain('--apply');
    expect(args).not.toContain('--remote');
    expect(args.slice(0, 3)).toEqual(['tools/bootstrap-tenancy.ts', '--owner', DEMO_OWNER]);
  });

  it('plans a membership per org and a legacy release per uploaded template', async () => {
    const { plan, sql } = await buildBootstrap(
      {
        owner: { id: 'u1', primary_email: DEMO_OWNER },
        orgs: [
          { id: 'o1', slug: 'northwind' },
          { id: 'o2', slug: 'harbor-lights' },
        ],
        templates: [
          {
            id: 't1',
            org_id: 'o1',
            active_version: '1',
            manifest: '{}',
            pass_json: '{}',
            assets: '[]',
          },
        ],
      },
      DEMO_OWNER,
      1_000,
    );
    expect(plan.filter((line) => line.includes('org_admin membership'))).toHaveLength(2);
    expect(plan.filter((line) => line.includes('legacy release'))).toHaveLength(1);
    expect(sql).toContain('INSERT INTO org_memberships');
    expect(sql).toContain("'legacy', 'legacy'");
  });
});
