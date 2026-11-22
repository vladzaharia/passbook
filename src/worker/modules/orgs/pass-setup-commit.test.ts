import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/index.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import type { TenantPassWrite } from '../passes/http.ts';
import { commit } from './pass-setup-commit.ts';
import type { SetupPlan } from './pass-setup-plan.ts';

const plan: SetupPlan = {
  name: null,
  branding: null,
  values: {},
  enable: [],
  blocked: [],
  allowed: [],
  diff: [],
  passLook: false,
  beyondBrandKit: true,
};

describe('commit for a brand:manage key', () => {
  const authority: TenantPassWrite = {
    kind: 'api_key',
    orgId: 'org',
    orgAccessRevision: 1,
    keyId: 'key',
    keyOrgId: 'org',
    scopes: ['brand:manage'],
    scope: 'brand:manage',
    mode: 'live',
  };
  const run = async (next: SetupPlan, upserts: Record<string, unknown>) => {
    const ctx = createServiceContext(await makeEnv());
    return commit(
      ctx,
      { type: 'api_key', id: 'key' },
      authority,
      'org',
      1,
      { plan: next, steps: new Map(), walletOnly: false },
      upserts,
      [],
    );
  };

  it('is refused a setting upsert and a rename before anything is written', async () => {
    await expect(run(plan, { 'email.buddy': true })).rejects.toMatchObject({ status: 403 });
    await expect(run({ ...plan, name: 'Renamed' }, {})).rejects.toMatchObject({ status: 403 });
  });
});
