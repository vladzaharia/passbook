import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { COUNTS_KEPT_MS, dailyImports, PII_KEPT_MS } from './import-retention.ts';
import { HEAD, type ImportHarness, setupImportHarness } from './import-test-fixtures.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});
beforeEach(async () => {
  await run(h.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-import%'");
  await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'failed' WHERE state = 'committing'");
});

const ctx = () => createJobContext(h.kit.env, 'pass-import', { clock: h.kit.clock });
const stateOf = (id: string) =>
  first<{ state: string }>(h.kit.env.DB, 'SELECT state FROM pass_imports WHERE id = ?', [id]);
const rowCount = async (id: string) =>
  (
    await first<{ n: number }>(
      h.kit.env.DB,
      'SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ?',
      [id],
    )
  )?.n;

describe('retention', () => {
  it('expires a draft after 23 hours, deletes its file and rows, and leaves a fresh draft', async () => {
    const old = await h.draft([HEAD, 'Old,1,,RE-1'].join('\n'));
    const fresh = await h.draft([HEAD, 'New,1,,RE-2'].join('\n'));
    const key = (
      await first<{ object_key: string }>(
        h.kit.env.DB,
        'SELECT object_key FROM pass_imports WHERE id = ?',
        [old.id],
      )
    )?.object_key as string;
    expect(await h.kit.env.BUCKET.head(key)).not.toBeNull();
    await run(h.kit.env.DB, 'UPDATE pass_imports SET expires_at = ? WHERE id = ?', [
      h.kit.clock.now() - 1,
      old.id,
    ]);
    await dailyImports(ctx());
    expect((await stateOf(old.id))?.state).toBe('expired');
    expect(await rowCount(old.id)).toBe(0);
    expect(await h.kit.env.BUCKET.head(key)).toBeNull();
    expect((await stateOf(fresh.id))?.state).toBe('ready');
    expect(await rowCount(fresh.id)).toBe(1);
  });

  it('clears cell values, emails and earlier values 30 days after the import ended', async () => {
    const d = await h.draft([HEAD, 'Pii,1,p@x.co,RP-1'].join('\n'));
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    await dailyImports(ctx());
    const kept = await first<{ input: string | null }>(
      h.kit.env.DB,
      'SELECT input FROM pass_import_rows WHERE import_id = ?',
      [d.id],
    );
    expect(kept?.input).not.toBeNull();

    await run(h.kit.env.DB, 'UPDATE pass_imports SET finished_at = ? WHERE id = ?', [
      h.kit.clock.now() - PII_KEPT_MS - 1,
      d.id,
    ]);
    await run(h.kit.env.DB, 'UPDATE pass_import_rows SET before = ? WHERE import_id = ?', [
      '{"a":1}',
      d.id,
    ]);
    await dailyImports(ctx());
    const row = await first<Record<string, unknown>>(
      h.kit.env.DB,
      'SELECT input, holder_email, external_id, before, state, result, pass_id FROM pass_import_rows WHERE import_id = ?',
      [d.id],
    );
    expect(row).toMatchObject({
      input: null,
      holder_email: null,
      external_id: null,
      before: null,
      state: 'done',
      result: 'created',
    });
    expect(row?.pass_id).not.toBeNull();
    expect((await stateOf(d.id))?.state).toBe('done');
  });

  it('drops imports after 400 days and never touches a running one', async () => {
    const d = await h.draft([HEAD, 'Del,1,,RD-1'].join('\n'));
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    const running = await h.draft([HEAD, 'Run,1,,RD-2'].join('\n'));
    await h.commit(running.id);
    const long = h.kit.clock.now() - COUNTS_KEPT_MS - 1;
    await run(
      h.kit.env.DB,
      'UPDATE pass_imports SET finished_at = ?, committed_at = ?, expires_at = ? WHERE id IN (?, ?)',
      [long, long, long, d.id, running.id],
    );
    await dailyImports(ctx());
    expect(await stateOf(d.id)).toBeNull();
    expect(await rowCount(d.id)).toBe(0);
    expect((await stateOf(running.id))?.state).toBe('committing');
    const left = await all<{ n: number }>(
      h.kit.env.DB,
      'SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ?',
      [running.id],
    );
    expect(left[0]?.n).toBe(1);
  });

  it('logs a stable code and goes on when one import cannot be written', async () => {
    const d = await h.draft([HEAD, 'Sus,1,,RF-1'].join('\n'));
    await run(h.kit.env.DB, 'UPDATE pass_imports SET expires_at = ? WHERE id = ?', [
      h.kit.clock.now() - 1,
      d.id,
    ]);
    await run(h.kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [h.kit.org.id]);
    try {
      await expect(dailyImports(ctx())).resolves.toBeUndefined();
      expect((await stateOf(d.id))?.state).toBe('ready');
    } finally {
      await run(h.kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [h.kit.org.id]);
    }
    await dailyImports(ctx());
    expect((await stateOf(d.id))?.state).toBe('expired');
  });
});
