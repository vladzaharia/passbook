import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeOrg } from '../../../../test/helpers/index.ts';
import { first, run } from '../../platform/db.ts';
import { createJobContext } from '../../platform/service-context.ts';
import { dailyImports, PII_KEPT_MS } from './import-retention.ts';
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
const stateOf = async (id: string) =>
  (
    await first<{ state: string }>(h.kit.env.DB, 'SELECT state FROM pass_imports WHERE id = ?', [
      id,
    ])
  )?.state;
const piiLeft = async (id: string) =>
  (
    await first<{ n: number }>(
      h.kit.env.DB,
      'SELECT count(*) AS n FROM pass_import_rows WHERE import_id = ? AND input IS NOT NULL',
      [id],
    )
  )?.n;

/** A finished import, moved to a second org when asked. */
async function ran(external: string, orgId?: string) {
  const d = await h.draft([HEAD, `N,1,,${external}`].join('\n'));
  await h.commit(d.id);
  await h.runWorkflow(d.id);
  if (orgId)
    await run(h.kit.env.DB, 'UPDATE pass_imports SET org_id = ? WHERE id = ?', [orgId, d.id]);
  return d.id;
}
const results = (id: string, headers = h.admin) => h.api(headers, 'GET', `/${id}/results.csv`);
const remove = (id: string, headers = h.admin) =>
  h.api(headers, 'POST', `/${id}/remove-created`, { cursor: null });

describe('isolation', () => {
  it("another org's import and the other mode's view are 404 for results and remove", async () => {
    const other = await makeOrg(h.kit.fx);
    const theirs = await ran('IS-1', other.id);
    const mine = await ran('IS-2');
    expect((await results(theirs)).status).toBe(404);
    expect((await remove(theirs)).status).toBe(404);
    const test = h.auth.admin({ mode: 'test' });
    expect((await results(mine, test)).status).toBe(404);
    expect((await remove(mine, test)).status).toBe(404);
    // Nothing of either was touched.
    expect(
      await first(
        h.kit.env.DB,
        "SELECT 1 AS x FROM passes WHERE external_id = 'IS-1' AND removed_at IS NOT NULL",
      ),
    ).toBeNull();
    expect(
      await first(
        h.kit.env.DB,
        "SELECT 1 AS x FROM passes WHERE external_id = 'IS-2' AND removed_at IS NOT NULL",
      ),
    ).toBeNull();
    expect((await results(mine)).status).toBe(200);
  });

  it("retention of one org's imports never touches another's", async () => {
    const other = await makeOrg(h.kit.fx);
    const a = await h.draft([HEAD, 'A,1,,IR-1'].join('\n'));
    const b = await h.draft([HEAD, 'B,1,,IR-2'].join('\n'));
    await run(h.kit.env.DB, 'UPDATE pass_imports SET org_id = ? WHERE id = ?', [other.id, b.id]);
    const due = h.kit.clock.now() - 1;
    await run(h.kit.env.DB, 'UPDATE pass_imports SET expires_at = ? WHERE id IN (?, ?)', [
      due,
      a.id,
      b.id,
    ]);
    await run(h.kit.env.DB, "UPDATE orgs SET status = 'suspended' WHERE id = ?", [h.kit.org.id]);
    try {
      await dailyImports(ctx());
    } finally {
      await run(h.kit.env.DB, "UPDATE orgs SET status = 'active' WHERE id = ?", [h.kit.org.id]);
    }
    expect(await stateOf(a.id)).toBe('ready');
    expect(await stateOf(b.id)).toBe('expired');
  });

  it("clearing one org's old rows leaves another org's rows", async () => {
    const other = await makeOrg(h.kit.fx);
    const mine = await ran('IC-1');
    const theirs = await ran('IC-2', other.id);
    await run(h.kit.env.DB, 'UPDATE pass_imports SET finished_at = ? WHERE id = ?', [
      h.kit.clock.now() - PII_KEPT_MS - 1,
      mine,
    ]);
    await dailyImports(ctx());
    expect(await piiLeft(mine)).toBe(0);
    expect(await piiLeft(theirs)).toBe(1);
  });
});
