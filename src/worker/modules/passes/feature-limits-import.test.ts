import { beforeAll, describe, expect, it } from 'vitest';
import { setLimit } from '../../../../test/helpers/index.ts';
import { all, first } from '../../platform/db.ts';
import { HEAD, type ImportHarness, setupImportHarness } from './import-test-fixtures.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});

const held = async () =>
  (
    await first<{ n: number }>(
      h.kit.env.DB,
      `SELECT COUNT(*) AS n FROM passes WHERE org_id = ? AND mode = 'live' AND removed_at IS NULL
        AND deleted_at IS NULL AND test_data_quarantined = 0`,
      [h.kit.org.id],
    )
  )?.n ?? 0;
const rowsOf = (id: string) =>
  all<{ row_no: number; state: string; result: string | null; code: string | null }>(
    h.kit.env.DB,
    'SELECT row_no, state, result, code FROM pass_import_rows WHERE import_id = ? ORDER BY row_no',
    [id],
  );

describe('a pass import at the plan limit', () => {
  it('stops creating at the limit, reports the rest as skipped, and still applies updates', async () => {
    await h.existing('U1', { memberName: 'Old', points: 1 });
    const before = await held();
    await setLimit(h.kit.env.DB, h.kit.org.id, 'passes.live', before + 2);
    const d = await h.draft(
      [HEAD, 'A,1,,N1', 'B,2,,N2', 'C,3,,N3', 'D,4,,N4', 'E,5,,N5', 'New,9,,U1'].join('\n'),
    );
    expect(d.counts).toMatchObject({ create: 5, update: 1 });
    await h.commit(d.id);
    expect(await h.runWorkflow(d.id)).toEqual({ state: 'done', code: null });

    const done = await h.get(d.id);
    expect(done.state).toBe('done');
    expect(done.progress).toMatchObject({ created: 2, updated: 1, skipped: 3, failed: 0 });
    expect(await held()).toBe(before + 2);
    const rows = await rowsOf(d.id);
    expect(rows.filter((r) => r.result === 'created')).toHaveLength(2);
    expect(rows.filter((r) => r.state === 'skipped')).toHaveLength(3);
    expect(
      rows.filter((r) => r.state === 'skipped').every((r) => r.code === 'FEATURE_LIMIT_REACHED'),
    ).toBe(true);
    expect(rows.find((r) => r.result === 'updated')).toBeTruthy();
  });

  it('a downgrade below what exists keeps every pass and skips every create', async () => {
    const before = await held();
    await setLimit(h.kit.env.DB, h.kit.org.id, 'passes.live', Math.max(before - 1, 0));
    const d = await h.draft([HEAD, 'F,1,,N6', 'G,2,,N7'].join('\n'));
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    const done = await h.get(d.id);
    expect(done.progress).toMatchObject({ created: 0, skipped: 2 });
    expect(await held()).toBe(before);
  });

  it('a legacy org imports everything', async () => {
    await setLimit(h.kit.env.DB, h.kit.org.id, 'passes.live', null);
    const before = await held();
    const d = await h.draft([HEAD, 'H,1,,N8', 'I,2,,N9'].join('\n'));
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    expect((await h.get(d.id)).progress).toMatchObject({ created: 2, skipped: 0 });
    expect(await held()).toBe(before + 2);
  });
});
