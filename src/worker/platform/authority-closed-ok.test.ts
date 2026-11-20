import { describe, expect, it } from 'vitest';
import { jobGrant } from './authority.ts';
import { codeOf, db, refusal } from './authority-ext-fixtures.ts';
import { setupGrant } from './authority-test-fixtures.ts';
import { run } from './db.ts';

type X = Awaited<ReturnType<typeof setupGrant>>;
const VOID = 'org_mode.job.org.purge_void';
const PUBLISH = 'org_mode.job.pass.publish';
const grantOf = (x: X, over: Record<string, unknown> = {}) =>
  jobGrant(x.ctx, {
    purpose: VOID,
    job: 'org-purge',
    orgId: x.s.org.id,
    mode: 'live',
    closedOk: true,
    tables: ['passes'],
    ...over,
  } as Parameters<typeof jobGrant>[1]);
const sql = (x: X, text: string) => run(db, text, [x.s.org.id]);

describe('closedOk job grants', () => {
  it('act only for a closed org in purge with no hold', async () => {
    const x = await setupGrant('cl-ok');
    await sql(x, "UPDATE orgs SET status = 'deleted', closed_at = 1, purge_after = 2 WHERE id = ?");
    expect(await refusal(grantOf(x).commit())).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
    await sql(x, 'UPDATE orgs SET purge_started_at = 3 WHERE id = ?');
    await expect(grantOf(x).commit()).resolves.toBeDefined();
    await run(
      db,
      "INSERT INTO retention_holds (id, org_id, placed_by_kind, placed_by, reason, created_at) VALUES (?, ?, 'platform', 'p', 'r', 1)",
      [`hold-${x.s.org.id}`, x.s.org.id],
    );
    expect(await refusal(grantOf(x).commit())).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
  });

  it('is refused for an open or suspended org', async () => {
    const x = await setupGrant('cl-open');
    expect(await refusal(grantOf(x).commit())).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
    await sql(x, "UPDATE orgs SET status = 'suspended' WHERE id = ?");
    expect(await refusal(grantOf(x).commit())).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
  });

  it('the generic publish purpose cannot carry it, and still refuses a closed org', async () => {
    const x = await setupGrant('cl-publish');
    expect(codeOf(() => grantOf(x, { purpose: PUBLISH }))).toBe('GRANT_BAD_PURPOSE');
    expect(codeOf(() => grantOf(x, { tables: ['passes', 'scans'] }))).toBe('GRANT_BAD_PURPOSE');
    await sql(
      x,
      "UPDATE orgs SET status = 'deleted', closed_at = 1, purge_after = 2, purge_started_at = 3 WHERE id = ?",
    );
    const publish = jobGrant(x.ctx, {
      purpose: PUBLISH,
      job: 'pass-publish',
      orgId: x.s.org.id,
      mode: 'live',
      tables: ['passes'],
    });
    expect(await refusal(publish.commit())).toMatchObject({ code: 'ORG_ACCESS_CHANGED' });
  });
});
