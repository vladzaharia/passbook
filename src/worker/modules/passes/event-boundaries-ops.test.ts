import { env } from 'cloudflare:workers';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg, makePass } from '../../../../test/helpers/index.ts';
import { estimateQueries } from '../../jobs/query-budget.ts';
import { countQueries } from '../../jobs/query-counter.ts';
import { all, first, run } from '../../platform/db.ts';
import { NotFoundError } from '../../platform/errors.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { claimBoundaries, handleBoundaryRefresh } from './event-boundaries.ts';
import {
  active,
  events,
  fetchApple,
  HOUR,
  MIN,
  rowOf,
  seasonKit,
  seasonPass,
  tick,
} from './event-boundaries-test-fixtures.ts';
import type { Kit } from './pass-test-fixtures.ts';
import { publishPass } from './publish.ts';
import { claimDueBoundaries } from './repo-boundaries.ts';

let kit: Kit;
beforeAll(async () => {
  kit = await seasonKit();
});
beforeEach(async () => {
  await run(kit.env.DB, 'DELETE FROM pass_boundaries');
});

describe('boundary rows that cannot move', () => {
  it('wait while the org is suspended and move once it is active again', async () => {
    const now = kit.clock.now();
    const org = await makeOrg(kit.fx, { name: 'Paused Club' });
    const pass = await seasonPass(kit, events(['A', now + HOUR, now + 2 * HOUR]), {
      orgId: org.id,
    });
    await run(kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [org.id]);
    expect(await tick(kit)).toBe(0);
    // Parked for an hour, so no claim scans it each minute.
    expect((await rowOf(kit, pass.id))?.due_at).toBe(now + HOUR);
    await run(kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [org.id]);
    expect(await tick(kit)).toBe(0);
    kit.clock.set(now + HOUR);
    expect(await tick(kit)).toBe(1);
    expect((await rowOf(kit, pass.id))?.due_at).toBe(now + 2 * HOUR + 1);
  });

  it('are dropped for voided, removed and deleted passes', async () => {
    const now = kit.clock.now();
    const list = events(['A', now + HOUR, now + 2 * HOUR]);
    const voided = await seasonPass(kit, list);
    const removed = await seasonPass(kit, list);
    const deleted = await seasonPass(kit, list);
    await publishPass(jobCtxOf(kit), {
      passId: voided.id,
      cause: 'admin',
      actor: { type: 'system', id: null },
      mutate: () => ({ status: 'voided' }),
    });
    await kit.settle();
    await run(kit.env.DB, 'UPDATE passes SET removed_at = ? WHERE id = ?', [now, removed.id]);
    await run(kit.env.DB, 'UPDATE passes SET deleted_at = ? WHERE id = ?', [now, deleted.id]);
    await tick(kit);
    for (const p of [voided, removed, deleted]) expect(await rowOf(kit, p.id)).toBeNull();
  });

  it('skip developer orgs, whose passes are never signed', async () => {
    const dev = await makeOrg(kit.fx, { name: 'Sandbox', kind: 'developer' });
    const pass = await makePass(kit.fx, {
      orgId: dev.id,
      mode: 'test',
      template: kit.template,
      persist: false,
    });
    await run(
      kit.env.DB,
      `INSERT INTO pass_versions (pass_id, version, object_key, template_version, personalization, pass_json, cause, created_at)
       SELECT id, 99, object_key, template_version, '{}', '{"upcomingPassInformation":[]}', 'admin', 1 FROM passes WHERE id = ?`,
      [pass.id],
    );
    // The trigger leaves a developer org out; a row that exists anyway is parked, never claimed.
    expect(await rowOf(kit, pass.id)).toBeNull();
    await run(
      kit.env.DB,
      'INSERT INTO pass_boundaries (pass_id, version, object_key, due_at) SELECT id, 1, object_key, 0 FROM passes WHERE id = ?',
      [pass.id],
    );
    expect(await tick(kit)).toBe(0);
    expect((await rowOf(kit, pass.id))?.due_at).toBe(kit.clock.now() + HOUR);
  });
});

describe('races and failures', () => {
  it('lets a version committed during the job win over its claim', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(kit, events(['A', now + HOUR, now + 2 * HOUR]));
    await tick(kit);
    kit.clock.set(now + HOUR);
    const ctx = jobCtxOf(kit);
    const from = kit.queue.sent.length;
    await claimBoundaries(ctx);
    const [job] = kit.queue.sent.splice(from) as Parameters<typeof handleBoundaryRefresh>[0][];
    // An edit lands between the claim and the job: its artifact already shows A running.
    const edited = await publishPass(ctx, {
      passId: pass.id,
      cause: 'admin',
      actor: { type: 'system', id: null },
      mutate: (current) => ({ personalization: { ...current.personalization, tier: 'Silver' } }),
    });
    await kit.settle();
    if (job) await handleBoundaryRefresh(job, ctx);
    expect(await rowOf(kit, pass.id)).toMatchObject({
      due_at: edited.pass.modifiedAt,
      rendered_at: 0,
    });
    await tick(kit);
    expect(await rowOf(kit, pass.id)).toMatchObject({ due_at: now + 2 * HOUR + 1, rendered_at: 0 });
    expect(active((await fetchApple(kit, pass)).json)).toEqual(['A']);
  });

  it('backs off on a failure and retires the row on a refusal retrying cannot fix', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(kit, events(['A', now + HOUR, now + 2 * HOUR]));
    const resolve = kit.registry.resolve;
    try {
      kit.registry.resolve = async () => {
        throw new Error('storage down');
      };
      await tick(kit);
      expect(await rowOf(kit, pass.id)).toMatchObject({ attempts: 1, due_at: now + MIN });
      kit.clock.set(now + MIN);
      await tick(kit);
      expect(await rowOf(kit, pass.id)).toMatchObject({ attempts: 2, due_at: now + 3 * MIN });
      kit.registry.resolve = async () => {
        throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
      };
      kit.clock.set(now + 3 * MIN);
      await tick(kit);
      expect(await rowOf(kit, pass.id)).toBeNull();
    } finally {
      kit.registry.resolve = resolve;
    }
  });

  it('spaces renders of one pass at least 5 minutes apart', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(
      kit,
      events(['A', now + HOUR, now + HOUR + MIN], ['B', now + HOUR + 2 * MIN, now + 2 * HOUR]),
    );
    await tick(kit);
    kit.clock.set(now + HOUR);
    await tick(kit);
    expect((await rowOf(kit, pass.id))?.due_at).toBe(now + HOUR + 5 * MIN);
    kit.clock.set(now + HOUR + 5 * MIN);
    await tick(kit);
    // A's end and B's start went out as one render.
    expect(active((await fetchApple(kit, pass)).json)).toEqual(['B']);
  });

  it('works the rows of a metadata-only edit from the backfill', async () => {
    const now = kit.clock.now();
    const pass = await seasonPass(kit, events(['A', now + HOUR, now + 2 * HOUR]));
    await run(kit.env.DB, 'DELETE FROM pass_boundaries');
    // A metadata-only edit: the version moves with no pass_versions row.
    await run(kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE id = ?', [pass.id]);
    const migration = (
      env as unknown as { TEST_MIGRATIONS: { name: string; queries: string[] }[] }
    ).TEST_MIGRATIONS.find((m) => m.name.endsWith('_passes_event_boundaries.sql'));
    const backfill = migration?.queries.at(-1) ?? '';
    expect(backfill).toMatch(/INSERT INTO pass_boundaries[^;]*MAX\(x\.version\)/);
    await run(kit.env.DB, backfill);
    expect((await rowOf(kit, pass.id))?.due_at).toBe(0);
    await tick(kit);
    expect((await rowOf(kit, pass.id))?.due_at).toBe(now + HOUR);
  });
});

describe('claims', () => {
  async function due(orgId: string, mode: 'live' | 'test', count: number) {
    for (let i = 0; i < count; i++) {
      const p = await makePass(kit.fx, { orgId, mode, template: kit.template, persist: false });
      await run(
        kit.env.DB,
        'INSERT INTO pass_boundaries (pass_id, version, object_key, due_at) SELECT id, 1, object_key, ? FROM passes WHERE id = ?',
        [kit.clock.now() - 1000 - i, p.id],
      );
    }
  }
  const claimedBy = (ids: string[]) =>
    all<{ org_id: string; mode: string; n: number }>(
      kit.env.DB,
      `SELECT org_id, mode, COUNT(*) AS n FROM passes WHERE id IN (SELECT value FROM json_each(?))
       GROUP BY org_id, mode ORDER BY org_id, mode`,
      [JSON.stringify(ids)],
    );

  it('caps each org, interleaves orgs and takes live before test', async () => {
    const [a, b, c] = [
      await makeOrg(kit.fx, { name: 'Big' }),
      await makeOrg(kit.fx, { name: 'Small' }),
      await makeOrg(kit.fx, { name: 'Trial' }),
    ];
    await due(a.id, 'live', 12);
    await due(b.id, 'live', 3);
    await due(b.id, 'test', 3);
    await due(c.id, 'test', 2);
    const now = kit.clock.now();
    const ids = await claimDueBoundaries(kit.env.DB, {
      now,
      lease: now + 5 * MIN,
      limit: 12,
      perOrg: 5,
    });
    const counts = Object.fromEntries(
      (await claimedBy(ids)).map((r) => [
        `${r.org_id === a.id ? 'a' : r.org_id === b.id ? 'b' : 'c'}:${r.mode}`,
        r.n,
      ]),
    );
    expect(counts).toEqual({ 'a:live': 5, 'b:live': 3, 'b:test': 2, 'c:test': 2 });
    const leased = await first<{ n: number }>(
      kit.env.DB,
      'SELECT COUNT(*) AS n FROM pass_boundaries WHERE due_at = ?',
      [now + 5 * MIN],
    );
    expect(leased?.n).toBe(12);
  });

  it('spends one claim query a tick whatever the backlog, and a bounded few per pass', async () => {
    const org = await makeOrg(kit.fx, { name: 'Busy' });
    await due(org.id, 'live', 60);
    const counter = countQueries(kit.env);
    const ctx = { ...jobCtxOf(kit), env: counter.env };
    const from = kit.queue.sent.length;
    await claimBoundaries(ctx);
    const jobs = kit.queue.sent.splice(from) as Parameters<typeof handleBoundaryRefresh>[0][];
    expect(jobs).toHaveLength(60);
    // The settings read and the claim.
    expect(counter.count()).toBeLessThanOrEqual(2);

    const now = kit.clock.now();
    const pass = await seasonPass(kit, events(['A', now + HOUR, now + 2 * HOUR]));
    await tick(kit);
    kit.clock.set(now + HOUR);
    await claimBoundaries(jobCtxOf(kit));
    const job = (kit.queue.sent.splice(from) as Parameters<typeof handleBoundaryRefresh>[0][]).find(
      (m) => m.kind === 'pass.boundary_refresh' && m.passId === pass.id,
    );
    const perPass = countQueries(kit.env);
    if (job) await handleBoundaryRefresh(job, { ...jobCtxOf(kit), env: perPass.env });
    expect((await rowOf(kit, pass.id))?.rendered_at).toBeGreaterThan(0);
    expect(perPass.count()).toBeLessThanOrEqual(
      estimateQueries(job ?? { kind: 'email.send', outboxId: '' }),
    );
  });
});
