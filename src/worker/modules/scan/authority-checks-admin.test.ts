import type { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeScanner } from '../../../../test/helpers/index.ts';
import { grant } from '../../platform/authority.ts';
import type { AppBindings } from '../../platform/context.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext } from '../../platform/service-context.ts';
import { scanActorChecks, scanPrincipal } from './authority-checks.ts';
import { createGuardHarness, get } from './guard-test-fixtures.ts';

const harness = createGuardHarness();

describe('admin scan principal', () => {
  let app: Hono<AppBindings>;
  let env: AppEnv;
  beforeEach(async () => {
    ({ app, env } = await harness.build());
  });

  /** An admin scan write: the guard captures the actor, the grant commits later. */
  async function capturedWrite() {
    const { orgId, clock, fake, f } = harness;
    const scanner = await makeScanner(f, { orgId });
    const captured = await get(app, env, `/capture-read?orgId=${orgId}&timeZone=UTC`, fake.admin());
    expect(captured.status).toBe(200);
    const actor = harness.capturedActor;
    if (actor?.principal !== 'admin') throw new Error('No admin actor captured.');
    const g = grant(createServiceContext(env, { clock }), {
      purpose: 'org_mode.scan.checkin',
      principal: scanPrincipal(actor),
      checks: scanActorChecks(actor, { now: clock.now() }),
    });
    g.update('scanners', { set: { last_seen_at: clock.now() }, where: { id: scanner.id } });
    return () => g.commit();
  }

  it('commits when the org access is unchanged (control)', async () => {
    const commit = await capturedWrite();
    await commit();
  });

  it('refuses with 403 ORG_ACCESS_CHANGED after a suspend and reactivate since capture', async () => {
    const commit = await capturedWrite();
    for (const status of ['suspended', 'active'])
      await run(env.DB, 'UPDATE orgs SET status=? WHERE id=?', [status, harness.orgId]);
    await expect(commit()).rejects.toMatchObject({ status: 403, code: 'ORG_ACCESS_CHANGED' });
  });
});
