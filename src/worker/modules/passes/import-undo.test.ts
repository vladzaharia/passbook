import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { runPassImport } from '../../workflows/pass-import.ts';
import { releaseHeldPage } from './import-held.ts';
import { HEAD, type ImportHarness, setupImportHarness, stepOf } from './import-test-fixtures.ts';
import { UNDO_WINDOW_MS, undoInstanceId } from './import-undo.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});
beforeEach(async () => {
  await run(h.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-import%'");
  await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'failed' WHERE state = 'committing'");
});

const undo = (id: string, headers = h.admin) => h.api(headers, 'POST', `/${id}/undo`, {});
const runUndo = (id: string) =>
  runPassImport(
    h.kit.env,
    undoInstanceId(id),
    { importId: id, orgId: h.kit.org.id, mode: 'live', undo: true },
    stepOf(),
  );
const pass = async (externalId: string) =>
  await first<{ id: string; removed_at: number | null; version: number; personalization: string }>(
    h.kit.env.DB,
    'SELECT id, removed_at, version, personalization FROM passes WHERE org_id = ? AND external_id = ?',
    [h.kit.org.id, externalId],
  );

async function imported(csv: string, body: unknown = {}) {
  const d = await h.draft(csv);
  expect((await h.commit(d.id, body)).status).toBe(200);
  await h.runWorkflow(d.id);
  return d.id;
}

describe('undo', () => {
  it('removes created passes, restores updated ones and keeps what changed since', async () => {
    await h.existing('U-OLD', { memberName: 'Old', points: 1 });
    await h.existing('U-EDIT', { memberName: 'Edit', points: 1 });
    const id = await imported(
      [HEAD, 'New,1,,U-NEW', 'Edited,1,,U-NEWEDIT', 'Newer,2,,U-OLD', 'Newest,3,,U-EDIT'].join(
        '\n',
      ),
    );
    expect((await pass('U-OLD'))?.personalization).toContain('Newer');
    // Someone edits one created pass and one updated pass after the import.
    await run(h.kit.env.DB, 'UPDATE passes SET version = version + 1 WHERE external_id = ?', [
      'U-EDIT',
    ]);
    const edited = await pass('U-NEWEDIT');
    await run(
      h.kit.env.DB,
      "INSERT INTO pass_versions (pass_id, version, cause, created_at) VALUES (?, 2, 'admin', 1) ON CONFLICT DO NOTHING",
      [edited?.id ?? ''],
    ).catch(() => undefined);
    const res = await undo(id);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { state: string }).state).toBe('running');
    await runUndo(id);
    const done = (await (await undo(id)).json()) as {
      state: string;
      removed: number;
      restored: number;
      keptTotal: number;
      kept: { code: string }[];
    };
    expect(done.state).toBe('done');
    expect((await pass('U-NEW'))?.removed_at).not.toBeNull();
    expect(JSON.parse((await pass('U-OLD'))?.personalization ?? '{}')).toMatchObject({
      memberName: 'Old',
    });
    // The pass whose version moved is kept as the import left it.
    expect(JSON.parse((await pass('U-EDIT'))?.personalization ?? '{}').memberName).toBe('Newest');
    expect(done.keptTotal).toBeGreaterThanOrEqual(1);
    expect(done.kept.map((k) => k.code)).toContain('IMPORT_PASS_CHANGED');
    expect((await h.get(id)).undo?.state).toBe('done');
  });

  it('asks twice and runs once', async () => {
    const id = await imported([HEAD, 'A,1,,U-ONCE'].join('\n'));
    await undo(id);
    await undo(id);
    expect(h.created.filter((c) => c.id === undoInstanceId(id))).toHaveLength(1);
  });

  it('refuses an import that is running, not run, or older than a day', async () => {
    const draft = await h.draft([HEAD, 'A,1,,U-DRAFT'].join('\n'));
    const early = await undo(draft.id);
    expect(early.status).toBe(409);
    const id = await imported([HEAD, 'A,1,,U-OLDER'].join('\n'));
    await run(h.kit.env.DB, 'UPDATE pass_imports SET finished_at = ? WHERE id = ?', [
      h.kit.clock.now() - UNDO_WINDOW_MS - 1,
      id,
    ]);
    const late = await undo(id);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { code: string }).code).toBe('IMPORT_UNDO_EXPIRED');
  });

  it('works for a key of the org, not for a read-only key', async () => {
    const id = await imported([HEAD, 'A,1,,U-KEY'].join('\n'));
    const read = await h.auth.apiKey({ orgId: h.kit.org.id, scopes: ['passes:read'] });
    expect((await undo(id, read)).status).toBe(403);
    expect((await undo(id, h.key)).status).toBe(200);
  });
});

describe('held email', () => {
  const held = { email: { send: 'held', holdMs: 60_000 } };
  const HOLD_HEAD = 'Name,Points,Email,Id';

  it('creates the passes without mail and sets when the mail goes out', async () => {
    const id = await imported([HOLD_HEAD, 'A,1,a@x.co,H-1', 'B,1,b@x.co,H-2'].join('\n'), held);
    const imp = await first<{ email_hold_until: number | null; email_hold_ms: number }>(
      h.kit.env.DB,
      'SELECT email_hold_until, email_hold_ms FROM pass_imports WHERE id = ?',
      [id],
    );
    expect(imp?.email_hold_ms).toBe(60_000);
    expect(imp?.email_hold_until).toBeGreaterThan(0);
    expect((await h.get(id)).emailHoldUntil).toBe(imp?.email_hold_until);
    const rows = await all<{ emailed: number }>(
      h.kit.env.DB,
      'SELECT emailed FROM pass_import_rows WHERE import_id = ?',
      [id],
    );
    expect(rows.every((r) => r.emailed === 0)).toBe(true);
  });

  it('an undo inside the window cancels the mail', async () => {
    const id = await imported([HOLD_HEAD, 'A,1,a@x.co,H-3'].join('\n'), held);
    const res = (await (await undo(id)).json()) as { emailsCancelled: number };
    expect(res.emailsCancelled).toBe(1);
  });

  const release = (id: string) =>
    releaseHeldPage(
      createJobContext(h.kit.env, 'pass-import'),
      { importId: id, orgId: h.kit.org.id, mode: 'live' },
      0,
    );
  const emailed = async (id: string) =>
    (
      await first<{ n: number }>(
        h.kit.env.DB,
        'SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ? AND emailed = 1',
        [id],
      )
    )?.n;

  it('mails the created passes after the wait, once', async () => {
    const id = await imported([HOLD_HEAD, 'A,1,a@x.co,H-4', 'B,1,b@x.co,H-5'].join('\n'), held);
    await release(id);
    expect(await emailed(id)).toBe(2);
    await release(id);
    expect(await emailed(id)).toBe(2);
  });

  it('mails nobody once the import is undone', async () => {
    const id = await imported([HOLD_HEAD, 'A,1,a@x.co,H-6'].join('\n'), held);
    await undo(id);
    expect(await release(id)).toEqual({ next: null });
    expect(await emailed(id)).toBe(0);
  });
});
