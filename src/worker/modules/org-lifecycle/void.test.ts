import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { runOrgPurge } from '../../workflows/org-purge.ts';
import { serialsSince } from '../apple/repo.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { removePass } from '../passes/remove.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { requestExport } from './export-start.ts';
import { fakeStep, populateOrg } from './lifecycle-test-fixtures.ts';
import { beginPurge, deletePassesPage, GRACE_MS, leftovers, runRows } from './purge.ts';
import { PURGE_STEPS } from './repo-plan.ts';
import { closeOrg } from './service.ts';

const DAY = 86_400_000;
const actor = { type: 'system' as const, id: null };
let rk: RetentionKit;
let kit: RetentionKit['kit'];
beforeAll(async () => {
  rk = await retentionKit();
  kit = rk.kit;
  // requestExport starts a workflow that would outlive the test; the purge is driven directly.
  (kit.env as { ORG_EXPORT: unknown }).ORG_EXPORT = {
    async create(o: { id: string }) {
      return { id: o.id };
    },
  };
}, 30_000);

const close = async (orgId: string) =>
  closeOrg(kit.ctx, actor, orgId, { kind: 'platform', ...(await rk.platform()) });
const state = (orgId: string) =>
  first<{ status: string }>(
    kit.env.DB,
    'SELECT status FROM passes WHERE org_id = ? AND mode = ? ORDER BY id LIMIT 1',
    [orgId, 'live'],
  );

describe('voiding at purge', () => {
  it('a closed org serves its voided passes and nothing else', async () => {
    const org = await populateOrg(rk, 'serve');
    const a = await kit.pass({ orgId: org.orgId });
    const b = await kit.pass({ orgId: org.orgId });
    await kit.device(a, 'dev-serve', 'tok-a');
    await kit.device(b, 'dev-serve', 'tok-b');
    const serials = async () =>
      (await serialsSince(kit.env.DB, 'dev-serve', a.identityId, 0, 10)).map((s) => s.passId);
    expect(await serials()).toHaveLength(2);
    await close(org.orgId);
    expect(await serials()).toEqual([]);
    // Voiding a closed org's pass is the purge's: it holds only once the purge has started.
    await expect(
      removePass(jobCtxOf(kit), actor, a.id, {}, null, undefined, undefined, true),
    ).rejects.toThrow();
    kit.clock.advance(31 * DAY);
    expect(await beginPurge(jobCtxOf(kit), org.orgId)).toBe('started');
    await removePass(jobCtxOf(kit), actor, a.id, {}, null, undefined, undefined, true);
    expect(await serials()).toEqual([a.id]);
  });

  it('a purge voids and pushes every pass first, and deletes nothing until the grace period is over', async () => {
    const org = await populateOrg(rk, 'grace');
    await close(org.orgId);
    kit.clock.advance(31 * DAY);
    const sent = kit.apns.sent.length;
    const seen: Record<string, unknown> = {};
    const step = fakeStep(undefined, kit.clock);
    (step as { sleepUntil: unknown }).sleepUntil = async (_n: string, until: Date) => {
      const passes = await all<{ status: string; removed_at: number | null }>(
        kit.env.DB,
        'SELECT status, removed_at FROM passes WHERE org_id = ?',
        [org.orgId],
      );
      seen.passes = passes;
      seen.pushes = kit.apns.sent.length - sent;
      seen.members = (
        await first<{ n: number }>(
          kit.env.DB,
          'SELECT count(*) AS n FROM org_memberships WHERE org_id = ?',
          [org.orgId],
        )
      )?.n;
      // Before the grace ends: no row goes, whatever asks.
      seen.rowsEarly = await runRows(kit.ctx, org.orgId, [PURGE_STEPS[2] as never]);
      seen.passesEarly = (await deletePassesPage(kit.ctx, org.orgId, '')).deleted;
      seen.served = await serialsSince(
        kit.env.DB,
        'device-grace',
        (passes.length
          ? (
              await first<{ identity_id: string }>(
                kit.env.DB,
                'SELECT identity_id FROM passes WHERE org_id = ? LIMIT 1',
                [org.orgId],
              )
            )?.identity_id
          : '') ?? '',
        0,
        10,
      );
      expect(until.getTime() - kit.clock.now()).toBe(GRACE_MS);
      kit.clock.advance(GRACE_MS);
    };
    const result = await runOrgPurge(kit.env, { orgId: org.orgId }, step, undefined, kit.clock, 2);
    expect(result.state).toBe('purged');
    const passes = seen.passes as { status: string; removed_at: number | null }[];
    expect(passes).toHaveLength(3);
    for (const p of passes) expect(p).toMatchObject({ status: 'voided' });
    for (const p of passes) expect(p.removed_at).not.toBeNull();
    expect(seen.pushes).toBeGreaterThanOrEqual(1);
    expect(seen.members).toBeGreaterThan(0);
    expect(seen.rowsEarly).toBe(0);
    expect(seen.passesEarly).toBe(0);
    expect((seen.served as unknown[]).length).toBe(1);
  });

  it('under a hold, nothing is voided', async () => {
    const org = await populateOrg(rk, 'nohold');
    await close(org.orgId);
    kit.clock.advance(31 * DAY);
    await run(
      kit.env.DB,
      "INSERT INTO retention_holds (id, org_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, 'platform', 'p', 'r', 1)",
      [kit.fx.ids.id(), org.orgId],
    );
    const result = await runOrgPurge(
      kit.env,
      { orgId: org.orgId },
      fakeStep(undefined, kit.clock),
      undefined,
      kit.clock,
      2,
    );
    expect(result.state).toBe('held');
    expect((await state(org.orgId))?.status).toBe('active');
  });
});

describe('an export against a purge', () => {
  it('a purge fails the open export, and its leftover files show up as an incomplete purge', async () => {
    const org = await populateOrg(rk, 'race');
    const row = await requestExport(kit.ctx, actor, org.orgId, {
      kind: 'platform',
      ...(await rk.platform()),
    });
    await close(org.orgId);
    kit.clock.advance(31 * DAY);
    await kit.env.BUCKET.put(`exports/${org.orgId}/${row.id}.zip`, new Uint8Array([1]));
    expect(await leftovers(kit.ctx, org.orgId)).toContain(`r2:exports/${org.orgId}/`);
    const result = await runOrgPurge(
      kit.env,
      { orgId: org.orgId },
      fakeStep(undefined, kit.clock),
      undefined,
      kit.clock,
      2,
    );
    expect(result.state).toBe('purged');
    expect((await kit.env.BUCKET.list({ prefix: `exports/${org.orgId}/` })).objects).toHaveLength(
      0,
    );
    expect(
      (await kit.env.BUCKET.list({ prefix: `member-photos/${org.orgId}/` })).objects,
    ).toHaveLength(0);
    expect((await kit.env.BUCKET.list({ prefix: 'uploads/up-race' })).objects).toHaveLength(0);
  });
});
