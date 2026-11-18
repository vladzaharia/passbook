import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { all, first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { applyChunk } from './import-apply.ts';
import { HEAD, type ImportHarness, plan, setupImportHarness } from './import-test-fixtures.ts';
import { beginCommit } from './repo-import-commit.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});
beforeEach(async () => {
  h.created.length = 0;
  await run(h.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-import%'");
  // One committing import per template: a test that stops mid-run must not block the next.
  await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'failed' WHERE state = 'committing'");
});

const passOf = (externalId: string) =>
  first<{ id: string; version: number; personalization: string; field_sources: string }>(
    h.kit.env.DB,
    `SELECT id, version, personalization, field_sources FROM passes
     WHERE org_id = ? AND external_id = ? AND removed_at IS NULL`,
    [h.kit.org.id, externalId],
  );
const rowsOf = (id: string) =>
  all<{
    row_no: number;
    state: string;
    result: string | null;
    code: string | null;
    pass_id: string | null;
  }>(
    h.kit.env.DB,
    'SELECT row_no, state, result, code, pass_id FROM pass_import_rows WHERE import_id = ? ORDER BY row_no',
    [id],
  );

describe('commit', () => {
  it('creates and updates the checked rows, and a double commit returns the same import', async () => {
    const old = await h.existing('C1', { memberName: 'Old', points: 1 }, { memberName: 'manual' });
    await h.existing('C2', { memberName: 'Same', points: 2 });
    const d = await h.draft(
      [HEAD, 'New,9,,C1', 'Same,2,,C2', 'Fresh,5,f@x.co,C3', 'Zed,,,C4'].join('\n'),
    );
    expect(d.counts).toMatchObject({ create: 2, update: 1, unchanged: 1, errors: 0 });

    const res = await h.commit(d.id);
    expect(res.status).toBe(200);
    expect((await h.commit(d.id)).status).toBe(200);
    expect(h.created).toHaveLength(1);
    expect(h.created[0]?.id).toBe(await h.instanceOf(d.id));

    const end = await h.runWorkflow(d.id);
    expect(end).toEqual({ state: 'done', code: null });
    const done = await h.get(d.id);
    expect(done.state).toBe('done');
    expect(done.progress).toMatchObject({
      done: 3,
      created: 2,
      updated: 1,
      unchanged: 1,
      failed: 0,
    });
    // The update replaced the hand-edited name (D6) and marks the field `import`; the pass moved one version.
    const updated = await passOf('C1');
    expect(updated?.id).toBe(old.id);
    expect(updated?.version).toBe(old.version + 1);
    expect(JSON.parse(updated?.personalization ?? '{}')).toEqual({ memberName: 'New', points: 9 });
    expect(JSON.parse(updated?.field_sources ?? '{}')).toEqual({
      memberName: 'import',
      points: 'import',
    });
    const fresh = await passOf('C3');
    expect(JSON.parse(fresh?.field_sources ?? '{}')).toEqual({
      memberName: 'import',
      points: 'import',
    });
    // A blank mapped cell is unset: the create leaves the key out.
    expect(JSON.parse((await passOf('C4'))?.personalization ?? '{}')).toEqual({
      memberName: 'Zed',
    });
    const audit = await all<{ action: string }>(
      h.kit.env.DB,
      "SELECT action FROM audit_log WHERE action LIKE 'pass_import.%' AND target_id = ?",
      [d.id],
    );
    expect(audit.map((a) => a.action).sort()).toEqual(['pass_import.commit', 'pass_import.finish']);
    const creator = await first<{ actor_type: string; actor_id: string }>(
      h.kit.env.DB,
      "SELECT actor_type, actor_id FROM audit_log WHERE action = 'pass.create' AND target_id = ?",
      [fresh?.id ?? ''],
    );
    expect(creator?.actor_type).toBe('user');
  });

  it('keeps hand-edited values only when asked, and a blank cell leaves a field as it is', async () => {
    await h.existing('K1', { memberName: 'Edited', points: 5 }, { memberName: 'manual' });
    await h.existing('K2', { memberName: 'Keep', points: 7 });
    const d = await h.draft(
      [HEAD, 'Csv,6,,K1', 'Keep,,,K2'].join('\n'),
      plan({ keepManual: true }),
    );
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    expect(JSON.parse((await passOf('K1'))?.personalization ?? '{}')).toEqual({
      memberName: 'Edited',
      points: 6,
    });
    expect(JSON.parse((await passOf('K2'))?.personalization ?? '{}')).toEqual({
      memberName: 'Keep',
      points: 7,
    });
  });

  it('refuses a draft with errors unless they are skipped, and never applies an error row', async () => {
    const d = await h.draft([HEAD, 'Good,1,,E1', 'Bad,x,,E2'].join('\n'));
    const refused = await h.commit(d.id);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: 'IMPORT_HAS_ERRORS' });
    expect((await h.get(d.id)).state).toBe('ready');
    expect((await h.commit(d.id, { skipInvalid: true })).status).toBe(200);
    await h.runWorkflow(d.id);
    expect(await passOf('E1')).not.toBeNull();
    expect(await passOf('E2')).toBeNull();
    expect((await rowsOf(d.id)).map((r) => r.state)).toEqual(['done', 'skipped']);
  });

  it('refuses a commit for a check that was replaced, and applies the rows as checked', async () => {
    const d = await h.draft([HEAD, 'Seen,1,,X1'].join('\n'));
    const before = await first<{ check_id: string }>(
      h.kit.env.DB,
      'SELECT check_id FROM pass_imports WHERE id = ?',
      [d.id],
    );
    // A second check replaces the rows and the run id.
    await h.api(h.admin, 'POST', `/${d.id}/check`, {
      plan: plan({ mapping: { memberName: { from: '/Name' } } }),
    });
    await expect(
      beginCommit(h.kit.ctx, h.keyAuthority, d.id, {
        checkId: before?.check_id ?? '',
        email: false,
        skipInvalid: false,
        starter: {
          kind: 'api_key',
          keyId: h.keyId,
          keyOrgId: h.kit.org.id,
          mode: 'live',
          orgAccessRevision: h.keyAuthority.orgAccessRevision,
        },
        emailBudget: 0,
        templateId: h.kit.template.id,
        counts: { create: 1, update: 0, errors: 0 },
      }),
    ).rejects.toMatchObject({ code: 'IMPORT_STATE' });
    expect((await h.get(d.id)).state).toBe('ready');

    // The file changes after the check: the commit still applies the checked rows.
    const imp = await first<{ object_key: string }>(
      h.kit.env.DB,
      'SELECT object_key FROM pass_imports WHERE id = ?',
      [d.id],
    );
    await h.kit.env.BUCKET.put(imp?.object_key ?? '', `${HEAD}\nChanged,9,,X9`);
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    expect(await passOf('X1')).not.toBeNull();
    expect(await passOf('X9')).toBeNull();
  });

  it('replays a step after a crash without creating a pass twice', async () => {
    const old = await h.existing('R1', { memberName: 'Old', points: 1 });
    const d = await h.draft([HEAD, 'Old,5,,R1', 'One,1,,R2', 'Two,2,,R3'].join('\n'));
    await h.commit(d.id);
    const ctx = createJobContext(h.kit.env, 'test');
    const params = { importId: d.id, orgId: h.kit.org.id, mode: 'live' as const };
    await run(h.kit.env.DB, 'UPDATE pass_imports SET state = state WHERE id = ?', [d.id]);
    expect(await applyChunk(ctx, params)).toEqual({ more: false });
    const first1 = await rowsOf(d.id);
    // Kill after the D1 writes: the rows were applied but not marked.
    await run(
      h.kit.env.DB,
      "UPDATE pass_import_rows SET state = 'planned', result = NULL WHERE import_id = ?",
      [d.id],
    );
    expect(await applyChunk(ctx, params)).toEqual({ more: false });
    const second = await rowsOf(d.id);
    expect(second.map((r) => r.pass_id)).toEqual(first1.map((r) => r.pass_id));
    expect(second.map((r) => [r.state, r.result])).toEqual([
      ['done', 'updated'],
      ['done', 'created'],
      ['done', 'created'],
    ]);
    const n = await first<{ n: number }>(
      h.kit.env.DB,
      'SELECT count(*) AS n FROM passes WHERE org_id = ? AND external_id IN (?, ?, ?)',
      [h.kit.org.id, 'R1', 'R2', 'R3'],
    );
    expect(n?.n).toBe(3);
    expect((await passOf('R1'))?.version).toBe(old.version + 1);
  });

  it('fails a row whose External ID was taken after the check, and finishes the rest', async () => {
    const d = await h.draft([HEAD, 'Mine,1,,T1', 'Other,2,,T2'].join('\n'));
    await h.existing('T1', { memberName: 'Hand made' });
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    const rows = await rowsOf(d.id);
    expect(rows.map((r) => [r.state, r.code])).toEqual([
      ['failed', 'CREATE_STALE'],
      ['done', null],
    ]);
    expect(JSON.parse((await passOf('T1'))?.personalization ?? '{}')).toEqual({
      memberName: 'Hand made',
    });
    expect((await h.get(d.id)).progress).toMatchObject({ created: 1, failed: 1 });
  });
});
