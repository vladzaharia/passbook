import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { countQueries } from '../../jobs/query-counter.ts';
import { first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { runPassImport } from '../../workflows/pass-import.ts';
import { applyChunk } from './import-apply.ts';
import { reserveImportEmail } from './import-email.ts';
import { sweepStuckImports } from './import-sweep.ts';
import {
  HEAD,
  type ImportHarness,
  plan,
  setupImportHarness,
  stepOf,
} from './import-test-fixtures.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});
beforeEach(async () => {
  await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'failed' WHERE state = 'committing'");
  await run(h.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-import%'");
});

const rows = (n: number, prefix: string) =>
  [HEAD, ...Array.from({ length: n }, (_, i) => `N${i},${i},,${prefix}${i}`)].join('\n');
const stateOf = (id: string) =>
  first<{ state: string; error_code: string | null }>(
    h.kit.env.DB,
    'SELECT state, error_code FROM pass_imports WHERE id = ?',
    [id],
  );
const setOrg = (status: string) =>
  run(h.kit.env.DB, 'UPDATE orgs SET status = ? WHERE id = ?', [status, h.kit.org.id]);

describe('a run that dies', () => {
  it('a suspended org mid-run ends the import, and the sweep frees one that was left behind', async () => {
    const key = await h.newKey();
    const d = await h.draft(rows(12, 'SU'), plan(), key.headers);
    await h.commit(d.id, {}, key.headers);
    try {
      const end = await h.runWorkflow(
        d.id,
        stepOf(async (name) => {
          if (name === 'chunk-0') await setOrg('suspended');
        }),
      );
      expect(end.code).toBe('IMPORT_STARTER_REVOKED');
      // The terminal write holds although the org is suspended.
      expect(await stateOf(d.id)).toEqual({
        state: 'failed',
        error_code: 'IMPORT_STARTER_REVOKED',
      });

      // A second import whose instance died with the org suspended, never reaching its finish.
      await setOrg('active');
      const e = await h.draft(rows(2, 'SW'), plan(), key.headers);
      await h.commit(e.id, {}, key.headers);
      await run(h.kit.env.DB, 'UPDATE pass_imports SET committed_at = 0 WHERE id = ?', [e.id]);
      h.statuses[await h.instanceOf(e.id)] = 'running';
      await setOrg('suspended');
      const ctx = createJobContext(h.kit.env, 'test');
      await sweepStuckImports(ctx);
      // A live instance is left alone.
      expect((await stateOf(e.id))?.state).toBe('committing');
      h.statuses[await h.instanceOf(e.id)] = 'errored';
      await sweepStuckImports(ctx);
      expect(await stateOf(e.id)).toEqual({ state: 'failed', error_code: 'IMPORT_FAILED' });
      const audit = await first<{ n: number }>(
        h.kit.env.DB,
        "SELECT count(*) AS n FROM audit_log WHERE action = 'pass_import.finish' AND target_id = ?",
        [e.id],
      );
      expect(audit?.n).toBe(1);
    } finally {
      await setOrg('active');
    }
  });

  it('a missing instance is freed too', async () => {
    const d = await h.draft(rows(1, 'MI'));
    await h.commit(d.id);
    h.created.length = 0;
    await run(h.kit.env.DB, 'UPDATE pass_imports SET committed_at = 0 WHERE id = ?', [d.id]);
    await sweepStuckImports(createJobContext(h.kit.env, 'test'));
    expect((await stateOf(d.id))?.state).toBe('failed');
  });
});

describe('re-commit', () => {
  it('a stale import is checked again and commits as a new run, keeping what it created', async () => {
    const d = await h.draft(rows(12, 'ST'));
    await h.commit(d.id);
    const first1 = await h.instanceOf(d.id);
    // The release moved after the commit: the first chunk applies, the next one stops.
    const end = await h.runWorkflow(
      d.id,
      stepOf(async (name) => {
        if (name === 'chunk-0')
          await run(
            h.kit.env.DB,
            'UPDATE pass_imports SET release_generation = release_generation + 7 WHERE id = ?',
            [d.id],
          );
      }),
    );
    expect(end).toEqual({ state: 'stale', code: 'IMPORT_STALE' });
    expect((await h.get(d.id)).state).toBe('stale');

    const res = await h.api(h.admin, 'POST', `/${d.id}/check`, { plan: plan() });
    expect(res.status).toBe(200);
    const again = await h.get(d.id);
    expect(again.state).toBe('ready');
    // The 5 created rows are not planned again, and still hold their results.
    expect(again.counts).toMatchObject({ rows: 7, create: 7 });
    const kept = await first<{ n: number }>(
      h.kit.env.DB,
      "SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ? AND result = 'created'",
      [d.id],
    );
    expect(kept?.n).toBe(5);

    expect((await h.commit(d.id)).status).toBe(200);
    const second = await h.instanceOf(d.id);
    expect(second).not.toBe(first1);
    expect(h.created.map((c) => c.id)).toEqual(expect.arrayContaining([first1, second]));
    expect((await h.runWorkflow(d.id)).state).toBe('done');
    expect((await h.get(d.id)).progress).toMatchObject({ created: 12, done: 12 });
  });

  it('an ambiguous start failure that created the instance keeps the commit', async () => {
    const d = await h.draft(rows(1, 'AM'));
    const create = h.kit.env.PASS_IMPORT.create.bind(h.kit.env.PASS_IMPORT);
    h.kit.env.PASS_IMPORT.create = async (o) => {
      await create(o);
      throw new Error('network');
    };
    try {
      expect((await h.commit(d.id)).status).toBe(200);
    } finally {
      h.kit.env.PASS_IMPORT.create = create;
    }
    expect((await h.get(d.id)).state).toBe('committing');
  });
});

describe('email reservation', () => {
  it('concurrent imports share the day budget', async () => {
    const now = h.kit.clock.now();
    const grants = await Promise.all([
      reserveImportEmail(h.kit.env.DB, 'live', h.kit.org.id, now, 400),
      reserveImportEmail(h.kit.env.DB, 'live', h.kit.org.id, now, 400),
    ]);
    expect(grants.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(500);
    expect(Math.max(...grants)).toBeGreaterThan(0);
  });
});

describe('limits', () => {
  it('2,000 rows run in at most 410 steps and 400 queries a step', async () => {
    const d = await h.draft(rows(1, 'LM'));
    await h.commit(d.id);
    await run(h.kit.env.DB, 'DELETE FROM pass_import_rows WHERE import_id = ?', [d.id]);
    // Updates of passes that do not exist fail fast: the workflow's shape is what is measured.
    for (let i = 0; i < 2000; i += 100) {
      const values = Array.from(
        { length: 100 },
        (_, j) => `(?, ${i + j + 2}, 'update', 'none-${i + j}', 1, '{}')`,
      ).join(',');
      await run(
        h.kit.env.DB,
        `INSERT INTO pass_import_rows (import_id, row_no, action, pass_id, expected_version, input) VALUES ${values}`,
        Array.from({ length: 100 }, () => d.id),
      );
    }
    const counter = countQueries(h.kit.env);
    let steps = 0;
    let worst = 0;
    let before = 0;
    const end = await runPassImport(
      counter.env,
      await h.instanceOf(d.id),
      { importId: d.id, orgId: h.kit.org.id, mode: 'live' },
      stepOf(async () => {
        steps++;
        worst = Math.max(worst, counter.count() - before);
        before = counter.count();
      }),
    );
    expect(end.state).toBe('done');
    expect(steps).toBeLessThanOrEqual(410);
    expect(worst).toBeLessThanOrEqual(400);
  }, 120_000);

  it('a chunk of creates stays under 400 queries', async () => {
    const d = await h.draft(rows(5, 'QC'));
    await h.commit(d.id);
    const counter = countQueries(h.kit.env);
    const ctx = createJobContext(counter.env, 'test');
    await applyChunk(ctx, { importId: d.id, orgId: h.kit.org.id, mode: 'live' });
    expect(counter.count()).toBeLessThanOrEqual(400);
  }, 120_000);
});
