import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { HEAD, type ImportHarness, plan, setupImportHarness } from './import-test-fixtures.ts';

let h: ImportHarness;
beforeAll(async () => {
  h = await setupImportHarness();
});
beforeEach(async () => {
  await run(h.kit.env.DB, "DELETE FROM counters WHERE key LIKE 'pass-import%'");
  await run(h.kit.env.DB, "UPDATE pass_imports SET state = 'failed' WHERE state = 'committing'");
});

const results = (id: string, headers = h.admin) => h.api(headers, 'GET', `/${id}/results.csv`);

describe('results.csv', () => {
  it('lists each row with its pass and links, no-store, with the formula guard', async () => {
    await h.existing('RS-U', { memberName: 'Same', points: 2 });
    const d = await h.draft(
      [HEAD, 'New,1,a@x.co,RS-1', 'Same,2,,RS-U', '=Evil,3,,=RS-3', 'Bad,x,,RS-4'].join('\n'),
    );
    await h.commit(d.id, { skipInvalid: true });
    await h.runWorkflow(d.id);
    const res = await results(d.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('text/csv');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).split('\r\n');
    expect(lines[0]).toBe('Row,Result,Pass ID,External ID,Email,Link,Download link,Problem');
    const cells = lines.slice(1).map((l) => l.split(','));
    expect(cells.map((c) => [c[0], c[1]])).toEqual([
      ['2', 'created'],
      ['3', 'unchanged'],
      ['4', 'created'],
      ['5', 'skipped'],
    ]);
    expect(cells[0]?.[4]).toBe('a@x.co');
    expect(cells[0]?.[5]).toMatch(/^https:\/\/.+\/p\/[\w-]+$/);
    expect(cells[0]?.[6]).toMatch(/\/pass\.pkpass$/);
    expect(cells[2]?.[3]).toBe("'=RS-3");
    // The error row shows its problem.
    expect(cells[3]?.[7]).not.toBe('');
    // Links are never stored: nothing of the import's rows carries one.
    const stored = await all<{ n: number }>(
      h.kit.env.DB,
      "SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ? AND (input LIKE '%/p/%' OR problems LIKE '%/p/%')",
      [d.id],
    );
    expect(stored[0]?.n).toBe(0);
  });

  it('audits each export without tokens or addresses', async () => {
    const d = await h.draft([HEAD, 'Aud,1,aud@x.co,RX-1'].join('\n'));
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    await results(d.id);
    await results(d.id);
    const rows = await all<{ detail: string }>(
      h.kit.env.DB,
      "SELECT detail FROM audit_log WHERE action = 'pass_import.results_export' AND target_id = ?",
      [d.id],
    );
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[0]?.detail ?? '')).toEqual({ importId: d.id, rows: 1 });
    expect(rows[0]?.detail).not.toMatch(/aud@x\.co|\/p\//);
  });

  it('leaves the link blank for a removed pass, and is refused before the import ran', async () => {
    const d = await h.draft([HEAD, 'Gone,1,,RG-1'].join('\n'));
    const early = await results(d.id);
    expect(early.status).toBe(409);
    await h.commit(d.id);
    await h.runWorkflow(d.id);
    await h.api(h.admin, 'POST', `/${d.id}/remove-created`, { cursor: null });
    const row = (await (await results(d.id)).text()).split('\r\n')[1]?.split(',') ?? [];
    expect(row[1]).toBe('created');
    expect(row[2]).not.toBe('');
    expect(row[5]).toBe('');
  });

  it('needs the operate capability (links are capabilities) and hides another import id', async () => {
    const d = await h.draft([HEAD, 'Key,1,,RK-1'].join('\n'), plan(), h.key);
    await h.commit(d.id, {}, h.key);
    await h.runWorkflow(d.id);
    expect((await results(d.id, h.key)).status).toBe(403);
    expect((await results('00000000-0000-7000-8000-000000000000')).status).toBe(404);
  });
});
