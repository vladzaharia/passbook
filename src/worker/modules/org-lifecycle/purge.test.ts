import { beforeAll, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { runOrgPurge } from '../../workflows/org-purge.ts';
import { readReceipts } from '../retention/receipt-service.ts';
import { type RetentionKit, retentionKit } from '../retention/retention-test-fixtures.ts';
import { dailyOrgLifecycle } from './jobs.ts';
import { fakeStep, populateOrg } from './lifecycle-test-fixtures.ts';
import { PURGE_KEEP } from './repo-plan.ts';
import { closeOrg, reopenOrg } from './service.ts';

const DAY = 86_400_000;
const actor = { type: 'system' as const, id: null };
let rk: RetentionKit;
let kit: RetentionKit['kit'];
beforeAll(async () => {
  rk = await retentionKit();
  kit = rk.kit;
}, 30_000);

const purge = (orgId: string, step = fakeStep(undefined, kit.clock)) =>
  runOrgPurge(kit.env, { orgId }, step, undefined, kit.clock, 2);
/** A fresh admin session each time: the tests move the clock past a session's life. */
const close = async (orgId: string) =>
  closeOrg(kit.ctx, actor, orgId, { kind: 'platform', ...(await rk.platform()) });
const closed = async (label: string) => {
  const org = await populateOrg(rk, label);
  await close(org.orgId);
  kit.clock.advance(31 * DAY);
  return org;
};
const hold = (orgId: string) =>
  run(
    kit.env.DB,
    "INSERT INTO retention_holds (id, org_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, 'platform', 'p', 'r', 1)",
    [kit.fx.ids.id(), orgId],
  );
const release = (orgId: string) =>
  run(
    kit.env.DB,
    "UPDATE retention_holds SET released_at = 2, released_by = 'p' WHERE org_id = ? AND released_at IS NULL",
    [orgId],
  );
const passCount = async (orgId: string) =>
  (
    await first<{ n: number }>(kit.env.DB, 'SELECT count(*) AS n FROM passes WHERE org_id = ?', [
      orgId,
    ])
  )?.n;

/** Rows of every table with an org_id column, for one org. */
async function rowsOf(orgId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const { name } of await all<{ name: string }>(
    kit.env.DB,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  )) {
    const cols = await all<{ name: string }>(
      kit.env.DB,
      `SELECT name FROM pragma_table_info('${name}')`,
    );
    if (!cols.some((c) => c.name === 'org_id')) continue;
    const n =
      (
        await first<{ n: number }>(
          kit.env.DB,
          `SELECT count(*) AS n FROM ${name} WHERE org_id = ?`,
          [orgId],
        )
      )?.n ?? 0;
    if (n > 0) out[name] = n;
  }
  return out;
}

describe('org purge', () => {
  it('leaves no row of the org but the stub, keeps every other org, and writes one receipt', async () => {
    const a = await populateOrg(rk, 'alpha');
    const b = await populateOrg(rk, 'beta');
    await close(a.orgId);
    const beforeB = await rowsOf(b.orgId);
    const bFile = await kit.env.BUCKET.list({ prefix: `passes/${b.passes[0]}/` });
    expect(Object.keys(await rowsOf(a.orgId)).length).toBeGreaterThan(15);
    kit.clock.advance(31 * DAY);
    const result = await purge(a.orgId);
    expect(result.state).toBe('purged');
    expect(result.deleted).toBeGreaterThan(10);

    const left = await rowsOf(a.orgId);
    expect(Object.keys(left).filter((t) => !(t in PURGE_KEEP))).toEqual([]);
    expect(left.audit_log).toBeGreaterThan(0);
    expect(left.retention_receipts).toBe(1);
    expect(await rowsOf(b.orgId)).toEqual(beforeB);
    expect((await kit.env.BUCKET.list({ prefix: `passes/${b.passes[0]}/` })).objects).toHaveLength(
      bFile.objects.length,
    );
    for (const id of a.passes)
      expect((await kit.env.BUCKET.list({ prefix: `passes/${id}/` })).objects).toHaveLength(0);
    expect((await kit.env.BUCKET.list({ prefix: `templates/${a.orgId}/` })).objects).toHaveLength(
      0,
    );
    expect(await all(kit.env.DB, 'PRAGMA foreign_key_check')).toEqual([]);
    const stub = await first<Record<string, unknown>>(
      kit.env.DB,
      'SELECT slug, name, branding, status, purged_at FROM orgs WHERE id = ?',
      [a.orgId],
    );
    expect(stub).toMatchObject({ name: 'Closed organization', branding: '{}', status: 'deleted' });
    expect(stub?.purged_at).toBeTypeOf('number');
    expect(
      await first(kit.env.DB, 'SELECT 1 AS x FROM settings WHERE scope = ?', [`org:${a.orgId}`]),
    ).toBeNull();

    const receipts = await readReceipts(kit.ctx, a.orgId, 'org_purge');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      verified: true,
      receipt: { kind: 'sweep', deleted: result.deleted },
    });
    expect(JSON.stringify(receipts)).not.toContain(a.holderEmail);

    // A second run does nothing and adds no receipt.
    expect((await purge(a.orgId)).state).toBe('done');
    expect(await readReceipts(kit.ctx, a.orgId, 'org_purge')).toHaveLength(1);
  });

  it('a hold stops a purge before it starts; releasing it lets it through', async () => {
    const org = await closed('held');
    await hold(org.orgId);
    const before = await rowsOf(org.orgId);
    expect((await purge(org.orgId)).state).toBe('held');
    expect(await rowsOf(org.orgId)).toEqual(before);
    expect(
      (
        await first<{ s: number | null }>(
          kit.env.DB,
          'SELECT purge_started_at AS s FROM orgs WHERE id = ?',
          [org.orgId],
        )
      )?.s,
    ).toBeNull();
    await release(org.orgId);
    expect((await purge(org.orgId)).state).toBe('purged');
  });

  it('a hold placed while the purge runs stops it and keeps the rest; a rerun finishes it', async () => {
    const org = await closed('mid');
    let held = false;
    const step = fakeStep(undefined, kit.clock);
    const inner = step.do.bind(step) as (n: string, ...a: unknown[]) => Promise<unknown>;
    (step as { do: unknown }).do = async (name: string, ...rest: unknown[]) => {
      if (!held && name.startsWith('rows-') && name.includes('connections')) {
        held = true;
        await hold(org.orgId);
      }
      return inner(name, ...rest);
    };
    expect((await purge(org.orgId, step)).state).toBe('held');
    const mid = await rowsOf(org.orgId);
    expect(mid.templates).toBe(1);
    expect(mid.org_memberships).toBeGreaterThan(0);
    await release(org.orgId);
    expect((await purge(org.orgId)).state).toBe('purged');
    expect(await readReceipts(kit.ctx, org.orgId, 'org_purge')).toHaveLength(1);
  });

  it('a run that crashes part way is finished by the next one, with one receipt', async () => {
    const org = await closed('crash');
    await expect(purge(org.orgId, fakeStep(12, kit.clock))).rejects.toThrow('crash');
    expect(Object.keys(await rowsOf(org.orgId)).length).toBeGreaterThan(6);
    expect((await purge(org.orgId)).state).toBe('purged');
    expect(await readReceipts(kit.ctx, org.orgId, 'org_purge')).toHaveLength(1);
    expect(await passCount(org.orgId)).toBe(0);
  });

  it('refuses an org that is open or whose window is still running', async () => {
    const open = await populateOrg(rk, 'open');
    expect((await purge(open.orgId)).state).toBe('skipped');
    const org = await populateOrg(rk, 'early');
    await close(org.orgId);
    expect((await purge(org.orgId)).state).toBe('not_due');
    expect(await passCount(org.orgId)).toBe(3);
  });

  it('the database refuses what the plan does not allow', async () => {
    const open = await populateOrg(rk, 'guard');
    const del = (orgId: string) =>
      run(kit.env.DB, 'DELETE FROM org_memberships WHERE org_id = ?', [orgId]);
    await expect(del(open.orgId)).rejects.toThrow(/immutable membership/);
    await close(open.orgId);
    await expect(del(open.orgId)).rejects.toThrow(/immutable membership/);
    await hold(open.orgId);
    kit.clock.advance(31 * DAY);
    await expect(
      run(kit.env.DB, 'UPDATE orgs SET purge_started_at = 5 WHERE id = ?', [open.orgId]),
    ).rejects.toThrow(/cannot be purged/);
    await release(open.orgId);
    await run(kit.env.DB, 'UPDATE orgs SET purge_started_at = 5 WHERE id = ?', [open.orgId]);
    await hold(open.orgId);
    await expect(del(open.orgId)).rejects.toThrow(/immutable membership/);
    await expect(
      run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [open.orgId]),
    ).rejects.toThrow(/being purged/);
  });

  it('a reopen is refused once the purge has started', async () => {
    const org = await closed('late');
    await run(kit.env.DB, 'UPDATE orgs SET purge_started_at = 5 WHERE id = ?', [org.orgId]);
    await expect(reopenOrg(kit.ctx, actor, org.orgId, await rk.platform())).rejects.toMatchObject({
      code: 'ORG_PURGING',
    });
  });

  it('the daily sweep starts one purge per due, unheld org and never twice a day', async () => {
    const started: { id: string; params: unknown }[] = [];
    const seen = new Set<string>();
    (kit.env as { ORG_PURGE: unknown }).ORG_PURGE = {
      async create(o: { id: string; params: unknown }) {
        if (seen.has(o.id)) throw new Error('exists');
        seen.add(o.id);
        started.push(o);
        return { id: o.id };
      },
    };
    const due = await closed('due');
    const stopped = await closed('stopped');
    await hold(stopped.orgId);
    await dailyOrgLifecycle(kit.ctx);
    expect(started.map((s) => s.params)).toContainEqual({ orgId: due.orgId });
    expect(started.map((s) => s.params)).not.toContainEqual({ orgId: stopped.orgId });
    const n = started.length;
    await dailyOrgLifecycle(kit.ctx);
    expect(started).toHaveLength(n);
  });
});
