import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { readReceipts } from '../retention/receipt-service.ts';
import { clearSettingsCache } from '../settings/service.ts';
import { COUNTS_KEPT_MS, dailyImports, isSettled, PII_KEPT_MS } from './import-retention.ts';
import { HEAD, type ImportHarness, setupImportHarness } from './import-test-fixtures.ts';
import { deleteImport } from './repo-import-retention.ts';

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

  it('never touches the rows of a committed import that went stale', async () => {
    const d = await h.draft([HEAD, 'St,1,,RS-1'].join('\n'));
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    await run(
      h.kit.env.DB,
      "UPDATE pass_imports SET state = 'stale', expires_at = ? WHERE id = ?",
      [h.kit.clock.now() - 1, d.id],
    );
    await dailyImports(ctx());
    expect((await stateOf(d.id))?.state).toBe('stale');
    expect(await rowCount(d.id)).toBe(1);
    const row = await first<{ result: string }>(
      h.kit.env.DB,
      'SELECT result FROM pass_import_rows WHERE import_id = ?',
      [d.id],
    );
    expect(row?.result).toBe('created');
  });

  it('scrubs a suspended org at 30 days, refuses a deleted one, and treats a second delete as settled', async () => {
    const d = await h.draft([HEAD, 'Sp,1,s@x.co,RU-1'].join('\n'));
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    await run(h.kit.env.DB, 'UPDATE pass_imports SET finished_at = ? WHERE id = ?', [
      h.kit.clock.now() - PII_KEPT_MS - 1,
      d.id,
    ]);
    const piiLeft = async () =>
      (
        await first<{ n: number }>(
          h.kit.env.DB,
          'SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ? AND input IS NOT NULL',
          [d.id],
        )
      )?.n;
    try {
      await run(h.kit.env.DB, "UPDATE orgs SET status = 'deleted' WHERE id = ?", [h.kit.org.id]);
      await dailyImports(ctx());
      expect(await piiLeft()).toBe(1);
      await run(h.kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [h.kit.org.id]);
      await dailyImports(ctx());
      expect(await piiLeft()).toBe(0);
      const imp = { id: d.id, org_id: h.kit.org.id, mode: 'live' as const, object_key: null };
      await deleteImport(ctx(), imp);
      const again = await deleteImport(ctx(), imp).catch((e: unknown) => e);
      expect(isSettled(again)).toBe(true);
    } finally {
      await run(h.kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [h.kit.org.id]);
    }
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

describe('retention plan', () => {
  const DAY = 86_400_000;
  const setDays = async (orgId: string, days: number) => {
    await run(
      h.kit.env.DB,
      "INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'retention.importsDays', ?, 1) ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value",
      [`org:${orgId}`, String(days)],
    );
    clearSettingsCache(h.kit.env.DB);
  };
  /** An ended import with one row holding an email, ended `ago` days back. */
  const seed = async (orgId: string, ago: number) => {
    const id = h.kit.fx.ids.id();
    const at = h.kit.clock.now() - ago * DAY;
    await run(
      h.kit.env.DB,
      `INSERT INTO pass_imports (id, org_id, mode, template_id, source_kind, source_name, state, created_by,
         created_at, committed_at, finished_at, expires_at) VALUES (?, ?, 'live', 't', 'file', 'f.csv', 'done', 'u', ?, ?, ?, ?)`,
      [id, orgId, at, at, at, at],
    );
    await run(
      h.kit.env.DB,
      "INSERT INTO pass_import_rows (import_id, row_no, action, holder_email, state) VALUES (?, 1, 'create', 'e@x.co', 'done')",
      [id],
    );
    return id;
  };
  const emailLeft = async (id: string) =>
    (
      await first<{ n: number }>(
        h.kit.env.DB,
        'SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ? AND holder_email IS NOT NULL',
        [id],
      )
    )?.n === 1;
  const hold = (orgId: string) =>
    run(
      h.kit.env.DB,
      "INSERT INTO retention_holds (id, org_id, pass_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, NULL, 'platform', 'p', 'r', 1)",
      [h.kit.fx.ids.id(), orgId],
    );
  const unhold = (orgId: string) =>
    run(
      h.kit.env.DB,
      "UPDATE retention_holds SET released_at = 2, released_by = 'p' WHERE org_id = ? AND released_at IS NULL",
      [orgId],
    );

  it('a shortened org setting purges earlier, another org keeps the default, and a receipt is written', async () => {
    const other = await makeOrg(h.kit.fx);
    const mine = await seed(other.id, 15);
    const theirs = await seed(h.kit.org.id, 15);
    await setDays(other.id, 10);
    await dailyImports(ctx());
    expect(await emailLeft(mine)).toBe(false);
    expect(await emailLeft(theirs)).toBe(true);
    const receipts = await readReceipts(ctx(), other.id, 'imports');
    expect(receipts.at(-1)?.receipt).toMatchObject({ policyDays: 10, anonymised: 1 });
  });

  it('a legal hold delays the purge until it is released', async () => {
    const other = await makeOrg(h.kit.fx);
    const id = await seed(other.id, 15);
    await setDays(other.id, 10);
    await hold(other.id);
    await dailyImports(ctx());
    expect(await emailLeft(id)).toBe(true);
    await unhold(other.id);
    await dailyImports(ctx());
    expect(await emailLeft(id)).toBe(false);
  });

  it('a floor wins over a shorter setting', async () => {
    const other = await makeOrg(h.kit.fx);
    const id = await seed(other.id, 15);
    await setDays(other.id, 10);
    await run(
      h.kit.env.DB,
      "INSERT INTO retention_floors (org_id, class, days, until) VALUES (?, 'imports', 20, ?)",
      [other.id, h.kit.clock.now() + 7 * DAY],
    );
    await dailyImports(ctx());
    expect(await emailLeft(id)).toBe(true);
  });

  it('keeps the default of 30 days and 400 days for an org that set nothing', async () => {
    const other = await makeOrg(h.kit.fx);
    const young = await seed(other.id, 29);
    const old = await seed(other.id, 31);
    const ancient = await seed(other.id, 401);
    await dailyImports(ctx());
    expect(await emailLeft(young)).toBe(true);
    expect(await emailLeft(old)).toBe(false);
    expect(await stateOf(old)).not.toBeNull();
    expect(await stateOf(ancient)).toBeNull();
  });
});
